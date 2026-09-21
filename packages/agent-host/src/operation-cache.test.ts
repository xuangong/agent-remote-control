import { AgentRuntimeError } from '@orchardworks/agent-provider-sdk';
import { describe, expect, it, vi } from 'vitest';

import { createOperationCache, OperationCacheError, type OperationDescriptor } from './operation-cache.js';

const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function descriptor(id = operationId, parameters: unknown = { text: 'hello' }): OperationDescriptor {
  return { operationId: id, scope: 'relay.example|host-one|installation-one', kind: 'send_message', target: 'codex:thread-one', parameters };
}

describe('operation cache', () => {
  it('executes concurrent duplicates once and returns the retained result', async () => {
    const cache = createOperationCache();
    let executions = 0;
    const dispatch = async () => {
      executions += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { accepted: true };
    };
    await expect(Promise.all([
      cache.execute(descriptor(), { dispatch }),
      cache.execute(descriptor(), { dispatch }),
    ])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    expect(executions).toBe(1);
    await cache.close();
  });

  it('rejects the same identity when its canonical intent changes', async () => {
    const cache = createOperationCache();
    await cache.execute(descriptor(), { dispatch: async () => ({ accepted: true }) });
    await expect(cache.execute(descriptor(operationId, { text: 'different' }), {
      dispatch: async () => ({ accepted: false }),
    })).rejects.toMatchObject({ code: 'operation_conflict' });
    await cache.close();
  });

  it('checks a completed duplicate before running fresh-request validation', async () => {
    const cache = createOperationCache();
    await cache.execute(descriptor(), { validate: () => undefined, dispatch: async () => ({ accepted: true }) });
    await expect(cache.execute(descriptor(), {
      validate: () => { throw new Error('The approval is no longer pending.'); },
      dispatch: async () => ({ accepted: false }),
    })).resolves.toEqual({ accepted: true });
    await cache.close();
  });

  it('expires a synchronous validation rejection and admits fresh work', async () => {
    let now = 1_000;
    const cache = createOperationCache({ maxEntries: 1, ttlMs: 10, now: () => now, cleanupIntervalMs: 10_000 });
    await expect(cache.execute(descriptor(), {
      validate: () => { throw Object.assign(new Error('The interaction is stale.'), { code: 'stale_interaction' }); },
      dispatch: async () => ({ accepted: false }),
    })).rejects.toMatchObject({ code: 'stale_interaction' });

    now += 11;
    await expect(cache.execute(descriptor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), {
      dispatch: async () => ({ accepted: true }),
    })).resolves.toEqual({ accepted: true });
    await cache.close();
  });

  it('retains unknown outcomes without dispatching a duplicate', async () => {
    const cache = createOperationCache();
    let executions = 0;
    const dispatch = async () => { executions += 1; throw new Error('reply lost'); };
    await expect(cache.execute(descriptor(), { dispatch })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    await expect(cache.execute(descriptor(), { dispatch })).rejects.toMatchObject({ code: 'operation_outcome_unknown' });
    expect(executions).toBe(1);
    await cache.close();
  });

  it('pins in-flight records while expiring settled records automatically', async () => {
    let now = 1_000;
    const cache = createOperationCache({ ttlMs: 100, now: () => now, cleanupIntervalMs: 10_000 });
    let release!: () => void;
    const blocked = cache.execute(descriptor(), { dispatch: () => new Promise<{ accepted: true }>((resolve) => { release = () => resolve({ accepted: true }); }) });
    await Promise.resolve();
    now += 101;
    const duplicate = cache.execute(descriptor(), { dispatch: async () => ({ accepted: false }) });
    release();
    await expect(Promise.all([blocked, duplicate])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    now += 101;
    await expect(cache.execute(descriptor(), { dispatch: async () => ({ accepted: 'new' }) })).resolves.toEqual({ accepted: 'new' });
    await cache.close();
  });

  it('rejects new work at count or byte capacity without disturbing reads of retained results', async () => {
    const byCount = createOperationCache({ maxEntries: 1 });
    await byCount.execute(descriptor(), { dispatch: async () => ({ accepted: true }) });
    await expect(byCount.execute(descriptor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), {
      dispatch: async () => ({ accepted: false }),
    })).rejects.toMatchObject({ code: 'operation_capacity_exceeded' });
    await expect(byCount.execute(descriptor(), { dispatch: async () => ({ accepted: false }) })).resolves.toEqual({ accepted: true });
    await byCount.close();

    const byBytes = createOperationCache({ maxBytes: 512 });
    await expect(byBytes.execute(descriptor(), {
      maximumResultBytes: 1_024,
      dispatch: async () => ({ accepted: true }),
    })).rejects.toMatchObject({ code: 'operation_capacity_exceeded' });
    await byBytes.close();
  });

  it('clears its cleanup timer and documents Host restart as a new cache lifetime', async () => {
    vi.useFakeTimers();
    try {
      const first = createOperationCache({ cleanupIntervalMs: 50 });
      await first.execute(descriptor(), { dispatch: async () => ({ generation: 1 }) });
      await first.close();
      expect(vi.getTimerCount()).toBe(0);

      const restarted = createOperationCache({ cleanupIntervalMs: 50 });
      await expect(restarted.execute(descriptor(), { dispatch: async () => ({ generation: 2 }) }))
        .resolves.toEqual({ generation: 2 });
      await restarted.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed operation identities before dispatch', async () => {
    const cache = createOperationCache();
    let dispatched = false;
    await expect(cache.execute(descriptor('request-one'), {
      dispatch: async () => { dispatched = true; return {}; },
    })).rejects.toBeInstanceOf(OperationCacheError);
    expect(dispatched).toBe(false);
    await cache.close();
  });
});


it('retains a classified file limit without replaying an uncertain mutation', async () => {
  const cache = createOperationCache();
  const dispatch = vi.fn(async () => { throw new AgentRuntimeError('native_file_limit', 'private details'); });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(cache.execute(descriptor(), { dispatch })).rejects.toMatchObject({
        code: 'native_file_limit', message: expect.stringContaining('may have reached'),
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally { await cache.close(); }
});
