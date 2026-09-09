import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ResourceIngestor } from './resource-ingestor.js';
import { InMemoryResourceStore } from './resource-store.js';

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe('ResourceIngestor validation', () => {
  it('does not send arbitrary URLs or parent traversal to the Provider reader', () => {
    let reads = 0;
    const ingestor = createIngestor();
    const reader = async () => {
      reads += 1;
      return { status: 'available' as const, bytes: pngBytes, mediaType: 'image/png' };
    };

    expect(ingestor.acquire({ agentId: 'agent-1', locator: 'https://example.com/output.png', reader })).toBeUndefined();
    expect(ingestor.acquire({ agentId: 'agent-1', locator: '../secret.png', reader })).toBeUndefined();
    expect(reads).toBe(0);
  });

  it('rejects bytes beyond the default 16 MiB limit', async () => {
    const ingestor = createIngestor();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'large.bin',
      reader: async () => ({
        status: 'available', mediaType: 'application/octet-stream',
        bytes: new Uint8Array(16 * 1024 * 1024 + 1),
      }),
    });

    expect(acquisition).toBeDefined();
    await expect(acquisition?.settled).resolves.toMatchObject({ status: 'failed' });
    expect(ingestor.readResponse('request-1', 'agent-1', acquisition!.binding.resourceId)).toMatchObject({
      type: 'resource_response',
      payload: { requestId: 'request-1', state: { status: 'failed', retryable: false } },
    });
  });

  it('rejects a declared media type that disagrees with detected bytes', async () => {
    const ingestor = createIngestor();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png',
      reader: async () => ({ status: 'available', mediaType: 'image/jpeg', bytes: pngBytes }),
    });

    await expect(acquisition?.settled).resolves.toMatchObject({ status: 'failed' });
    expect(ingestor.readResponse('request-1', 'agent-1', acquisition!.binding.resourceId).payload.state)
      .toEqual({ status: 'failed', message: 'Declared media type does not match the resource bytes.', retryable: false });
  });

  it('rejects empty bytes that cannot produce a valid available wire response', async () => {
    const ingestor = createIngestor();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'empty.txt',
      reader: async () => ({ status: 'available', mediaType: 'text/plain', bytes: new Uint8Array() }),
    });

    await acquisition?.settled;
    expect(ingestor.readResponse('request-1', 'agent-1', acquisition!.binding.resourceId).payload.state)
      .toEqual({ status: 'failed', message: 'Resource is empty.', retryable: false });
  });

  it('exposes pending state before acquisition settles', () => {
    const ingestor = createIngestor();
    const pending = deferred<ReturnType<typeof availablePng>>();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: './output.png', reader: () => pending.promise,
    });

    expect(acquisition?.binding).toEqual({
      locator: './output.png', resourceId: 'resource-1', status: 'pending',
    });
    expect(ingestor.readResponse('request-1', 'agent-1', 'resource-1').payload.state)
      .toEqual({ status: 'pending', retryAfterMs: 250 });
    pending.resolve(availablePng());
  });

  it('derives response byte length and SHA-256 from the stored blob bytes', async () => {
    const store = new MetadataDriftResourceStore();
    const ingestor = createIngestor(store);
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', reader: async () => availablePng(),
    });
    await acquisition?.settled;

    expect(ingestor.readResponse('read-1', 'agent-1', acquisition!.binding.resourceId).payload.state)
      .toMatchObject({
        status: 'available',
        byteLength: pngBytes.byteLength,
        sha256: createHash('sha256').update(pngBytes).digest('hex'),
      });
  });

  it('keeps available lifecycle updates free of resource bytes', async () => {
    const ingestor = createIngestor();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', reader: async () => availablePng(),
    });
    await acquisition?.settled;

    const state = ingestor.readState('agent-1', acquisition!.binding.resourceId);
    expect(state).toEqual({
      status: 'available',
      mediaType: 'image/png',
      byteLength: pngBytes.byteLength,
      sha256: createHash('sha256').update(pngBytes).digest('hex'),
    });
    expect(ingestor.readResponse('read-1', 'agent-1', acquisition!.binding.resourceId).payload.state)
      .toMatchObject({ status: 'available', contentBase64: Buffer.from(pngBytes).toString('base64') });
  });

  it('withholds an available response when stored bytes no longer match the record SHA-256', async () => {
    const store = new ByteDriftResourceStore();
    const ingestor = createIngestor(store);
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', reader: async () => availablePng(),
    });
    await acquisition?.settled;

    expect(ingestor.readResponse('read-1', 'agent-1', acquisition!.binding.resourceId).payload.state)
      .toEqual({ status: 'unavailable', reason: 'Durable resource bytes failed integrity validation.' });
  });
});

describe('ResourceIngestor acquisition lifecycle', () => {
  it('shares one in-flight acquisition for concurrent observations of the same locator', async () => {
    const ingestor = createIngestor();
    const pending = deferred<ReturnType<typeof availablePng>>();
    let reads = 0;
    const reader = () => {
      reads += 1;
      return pending.promise;
    };

    const first = ingestor.acquire({ agentId: 'agent-1', locator: 'output.png', reader });
    const second = ingestor.acquire({ agentId: 'agent-1', locator: './output.png', reader });

    expect(first?.binding.resourceId).toBe('resource-1');
    expect(second?.binding.resourceId).toBe('resource-1');
    expect(reads).toBe(1);
    pending.resolve(availablePng());
    await expect(Promise.all([first?.settled, second?.settled])).resolves.toEqual([
      { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
      { locator: './output.png', resourceId: 'resource-1', status: 'available' },
    ]);
  });

  it('keeps concurrent read identities independent while preserving the public locator', async () => {
    const ingestor = createIngestor();
    const firstPending = deferred<ReturnType<typeof availablePng>>();
    const secondBytes = new Uint8Array([...pngBytes, 1]);
    const reads: string[] = [];
    const reader = (locator: string) => {
      reads.push(locator);
      return locator === 'provider-resource:first'
        ? firstPending.promise
        : Promise.resolve(availablePng(secondBytes));
    };

    const first = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', readLocator: 'provider-resource:first', reader,
    });
    const second = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', readLocator: 'provider-resource:second', reader,
    });

    expect(first?.binding).toEqual({ locator: 'output.png', resourceId: 'resource-1', status: 'pending' });
    expect(second?.binding).toEqual({ locator: 'output.png', resourceId: 'resource-2', status: 'pending' });
    expect(reads).toEqual(['provider-resource:first', 'provider-resource:second']);
    firstPending.resolve(availablePng());
    await Promise.all([first?.settled, second?.settled]);
    expect(ingestor.readResponse('read-first', 'agent-1', first!.binding.resourceId).payload.state).toMatchObject({
      status: 'available', contentBase64: Buffer.from(pngBytes).toString('base64'),
    });
    expect(ingestor.readResponse('read-second', 'agent-1', second!.binding.resourceId).payload.state).toMatchObject({
      status: 'available', contentBase64: Buffer.from(secondBytes).toString('base64'),
    });
  });

  it('creates a new resource revision when the same locator later has different bytes', async () => {
    const ingestor = createIngestor();
    const first = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', reader: async () => availablePng(pngBytes),
    });
    await first?.settled;
    const changedBytes = new Uint8Array([...pngBytes, 1]);
    const second = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png', reader: async () => availablePng(changedBytes),
    });
    await second?.settled;

    expect(second?.binding.resourceId).not.toBe(first?.binding.resourceId);
    const firstResponse = ingestor.readResponse('read-1', 'agent-1', first!.binding.resourceId);
    const secondResponse = ingestor.readResponse('read-2', 'agent-1', second!.binding.resourceId);
    expect(firstResponse.payload.state).toMatchObject({ status: 'available', byteLength: pngBytes.byteLength });
    expect(secondResponse.payload.state).toMatchObject({ status: 'available', byteLength: changedBytes.byteLength });
    expect(stateSha256(firstResponse)).not.toBe(stateSha256(secondResponse));
  });

  it('reuses the settled resource identity when the same locator still has the same bytes', async () => {
    const ingestor = createIngestor();
    let reads = 0;
    const reader = async () => {
      reads += 1;
      return availablePng();
    };
    const first = ingestor.acquire({ agentId: 'agent-1', locator: 'output.png', reader });
    const firstBinding = await first?.settled;
    const second = ingestor.acquire({ agentId: 'agent-1', locator: './output.png', reader });

    expect(second?.binding.resourceId).toBe('resource-2');
    await expect(second?.settled).resolves.toEqual({
      locator: './output.png', resourceId: firstBinding?.resourceId, status: 'available',
    });
    expect(reads).toBe(2);
    expect(ingestor.readResponse('read-1', 'agent-1', firstBinding!.resourceId).payload.state)
      .toMatchObject({ status: 'available', byteLength: pngBytes.byteLength });
  });

  it('keeps Provider unavailability visible and does not expose it through another Agent', async () => {
    const ingestor = createIngestor();
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'missing.png',
      reader: async () => ({ status: 'unavailable', reason: 'The generated file expired.' }),
    });
    await expect(acquisition?.settled).resolves.toEqual({
      locator: 'missing.png', resourceId: 'resource-1', status: 'unavailable',
    });

    expect(ingestor.readResponse('read-1', 'agent-1', 'resource-1').payload.state)
      .toEqual({ status: 'unavailable', reason: 'The generated file expired.' });
    expect(ingestor.readResponse('read-2', 'agent-2', 'resource-1').payload.state)
      .toEqual({ status: 'unavailable', reason: 'Resource is not available to this Agent.' });
  });

  it('makes a bounded reader failure visible after automatic retries end', async () => {
    let reads = 0;
    const ingestor = new ResourceIngestor({
      store: new InMemoryResourceStore(), createResourceId: () => 'resource-1', maxAttempts: 2,
    });
    const acquisition = ingestor.acquire({
      agentId: 'agent-1', locator: 'output.png',
      reader: async () => {
        reads += 1;
        throw new Error('reader stopped');
      },
    });

    await acquisition?.settled;
    expect(reads).toBe(2);
    expect(ingestor.readResponse('read-1', 'agent-1', 'resource-1').payload.state)
      .toEqual({ status: 'failed', message: 'Resource acquisition failed.', retryable: true });
  });
});

function availablePng(bytes = pngBytes) {
  return { status: 'available' as const, mediaType: 'image/png', bytes };
}

function createIngestor(store = new InMemoryResourceStore()): ResourceIngestor {
  let nextId = 1;
  return new ResourceIngestor({ store, createResourceId: () => `resource-${nextId++}` });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function stateSha256(response: ReturnType<ResourceIngestor['readResponse']>): string | undefined {
  return response.payload.state.status === 'available' ? response.payload.state.sha256 : undefined;
}

class MetadataDriftResourceStore extends InMemoryResourceStore {
  override getBlob(sha256: string) {
    const blob = super.getBlob(sha256);
    return blob ? { ...blob, byteLength: blob.byteLength + 100 } : undefined;
  }
}

class ByteDriftResourceStore extends InMemoryResourceStore {
  override getBlob(sha256: string) {
    const blob = super.getBlob(sha256);
    return blob ? { ...blob, bytes: new Uint8Array([...blob.bytes, 1]) } : undefined;
  }
}
