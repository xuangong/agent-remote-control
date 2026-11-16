import { createHash, createHmac, randomUUID } from 'node:crypto';

import type { AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type ResourceBinding,
  type ResourceResponse,
  type ResourceState,
} from '@orchardworks/agent-remote-protocol';

import { detectMediaType } from './media-type.js';
import { readImageDimensions } from './image-dimensions.js';
import { normalizeFileLocator } from './markdown-locators.js';
import type { ResourceIdIndex } from './resource-id-index.js';
import type { ResourceStore, StoredResourceState } from './resource-store.js';

export const DEFAULT_MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

export type ResourceReader = (locator: string) => Promise<AgentResourceReadResult>;

export interface ResourceAcquisition {
  binding: ResourceBinding;
  settled: Promise<ResourceBinding>;
}

export interface ResourceIngestorOptions {
  store: ResourceStore;
  maxBytes?: number;
  maxAttempts?: number;
  retryAfterMs?: number;
  createResourceId?: () => string;
  /**
   * A secret the owner keeps with the Controller's state. With it, a resource that settles as available gets an id that is
   * the same for the same agent, locator and bytes in every process, and that nobody can derive. Without it ids are random.
   */
  resourceIdKey?: string;
  /** Remembers settled resources of `durable` acquisitions, so that `restore` can read one again after a restart. Needs `resourceIdKey`. */
  resourceIdIndex?: ResourceIdIndex;
}

const MAX_ALIASES = 50_000;

/** The id of an available resource: a keyed hash of its agent, normalized locator and content. */
export function stableResourceId(key: string, agentId: string, normalizedLocator: string, sha256: string): string {
  return `rid_${createHmac('sha256', key).update(JSON.stringify([agentId, normalizedLocator, sha256])).digest('base64url').slice(0, 32)}`;
}

interface SettledResource {
  resourceId: string;
  state: StoredResourceState;
}

export class ResourceIngestor {
  /** The stable id each provisional id of an acquisition settled as, per agent. A holder of the provisional id keeps reading. */
  private readonly aliases = new Map<string, string>();
  private readonly restoring = new Map<string, Promise<void>>();
  private readonly inFlight = new Map<string, { resourceId: string; settled: Promise<SettledResource> }>();
  private readonly maxBytes: number;
  private readonly maxAttempts: number;
  private readonly retryAfterMs: number;
  private readonly createResourceId: () => string;

  constructor(private readonly options: ResourceIngestorOptions) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_RESOURCE_BYTES;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.retryAfterMs = options.retryAfterMs ?? 250;
    this.createResourceId = options.createResourceId ?? randomUUID;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Resource byte limit must be positive.');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1) throw new Error('Resource attempts must be positive.');
    if (!Number.isSafeInteger(this.retryAfterMs) || this.retryAfterMs < 1) throw new Error('Resource retry interval must be positive.');
  }

  acquire(input: {
    agentId: string;
    locator: string;
    normalizedLocator?: string;
    readLocator?: string;
    reader?: ResourceReader;
    /** Remember the settled resource in the resource id index, so that its id can be restored after a restart. */
    durable?: boolean;
  }): ResourceAcquisition | undefined {
    const normalizedLocator = input.normalizedLocator ?? normalizeFileLocator(input.locator);
    if (!normalizedLocator) return undefined;
    const readIdentity = input.readLocator === undefined
      ? `locator:${normalizedLocator}`
      : `reference:${input.readLocator.length}:${input.readLocator}`;
    const key = `${input.agentId}\0${normalizedLocator}\0${readIdentity}`;
    const existing = this.inFlight.get(key);
    if (existing) return this.acquisition(input.locator, existing.resourceId, existing.settled);

    const resourceId = this.createResourceId();
    this.options.store.createRecord({
      resourceId,
      agentId: input.agentId,
      locator: input.locator,
      normalizedLocator,
      state: { status: 'pending', retryAfterMs: this.retryAfterMs },
    });
    const settled = this.runAcquisition(
      input.agentId,
      resourceId,
      normalizedLocator,
      input.readLocator ?? input.locator,
      input.reader,
      input.durable === true,
    )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { resourceId, settled });
    return this.acquisition(input.locator, resourceId, settled);
  }

  /** The id a resource is stored under: the stable id that a provisional id settled as, or the id itself. */
  canonicalId(agentId: string, resourceId: string): string {
    return this.aliases.get(`${agentId}\0${resourceId}`) ?? resourceId;
  }

  /**
   * Reads a resource this Controller settled before a restart again, when nothing holds its id now. The record is pending
   * until the bytes arrive; they are served only if their sha256 is the one remembered, so changed content is never shown
   * under the old id. Returns undefined when there is nothing to restore; the promise settles when the record does.
   */
  restore(agentId: string, resourceId: string, reader: ResourceReader): Promise<void> | undefined {
    const id = this.canonicalId(agentId, resourceId);
    const entry = this.options.resourceIdIndex?.get(agentId, id);
    if (!entry) return undefined;
    const running = this.restoring.get(`${agentId}\0${id}`);
    if (running) return running;
    const record = this.options.store.getRecord(agentId, id);
    if (record && !(record.state.status === 'failed' && record.state.retryable)) return undefined;
    const pending: StoredResourceState = { status: 'pending', retryAfterMs: this.retryAfterMs };
    if (record) this.options.store.updateRecordState(agentId, id, pending);
    else this.options.store.createRecord({ resourceId: id, agentId, locator: entry.normalizedLocator, normalizedLocator: entry.normalizedLocator, state: pending });
    const settled = this.readRemembered(agentId, id, entry.readLocator, entry.sha256, reader)
      .then(state => { this.options.store.updateRecordState(agentId, id, state); })
      .finally(() => this.restoring.delete(`${agentId}\0${id}`));
    this.restoring.set(`${agentId}\0${id}`, settled);
    return settled;
  }

  private async readRemembered(agentId: string, resourceId: string, readLocator: string, sha256: string, reader: ResourceReader): Promise<StoredResourceState> {
    try {
      const result = await reader(readLocator);
      if (result.status === 'unavailable') return { status: 'unavailable', reason: result.reason };
      if (result.bytes.byteLength === 0 || result.bytes.byteLength > this.maxBytes) {
        return { status: 'failed', message: 'Resource cannot be restored.', retryable: false };
      }
      const detectedMediaType = detectMediaType(result.bytes);
      const actual = createHash('sha256').update(result.bytes).digest('hex');
      if (actual !== sha256 || normalizeMediaType(result.mediaType) !== detectedMediaType) {
        return { status: 'unavailable', reason: 'Resource content changed.' };
      }
      this.options.store.putBlob({ sha256, mediaType: detectedMediaType, bytes: result.bytes });
      const imageDimensions = readImageDimensions(result.bytes, detectedMediaType);
      return { ...(imageDimensions ? { imageDimensions } : {}), status: 'available', mediaType: detectedMediaType, byteLength: result.bytes.byteLength, sha256 };
    } catch {
      return { status: 'failed', message: 'Resource restoration failed.', retryable: true };
    }
  }

  readResponse(requestId: string, agentId: string, resourceId: string): ResourceResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'resource_response',
      payload: {
        requestId,
        agentId,
        resourceId,
        state: this.readResponseState(agentId, this.canonicalId(agentId, resourceId)),
      },
    };
  }

  readState(agentId: string, resourceId: string): ResourceState {
    const state = this.readResponseState(agentId, this.canonicalId(agentId, resourceId));
    if (state.status !== 'available') return state;
    return {
      status: 'available',
      mediaType: state.mediaType,
      byteLength: state.byteLength,
      sha256: state.sha256,
      ...(state.imageDimensions ? { imageDimensions: state.imageDimensions } : {}),
    };
  }

  private readResponseState(agentId: string, resourceId: string): ResourceResponse['payload']['state'] {
    const record = this.options.store.getRecord(agentId, resourceId);
    const state = record?.state ?? {
      status: 'unavailable' as const,
      reason: 'Resource is not available to this Agent.',
    };
    return state.status === 'available' ? this.availableResponse(state) : structuredClone(state);
  }

  private acquisition(locator: string, resourceId: string, settled: Promise<SettledResource>): ResourceAcquisition {
    return {
      binding: { locator, resourceId, status: 'pending' },
      settled: settled.then((result) => ({
        locator,
        resourceId: result.resourceId,
        status: result.state.status,
      })),
    };
  }

  private async runAcquisition(
    agentId: string,
    resourceId: string,
    normalizedLocator: string,
    readLocator: string,
    reader: ResourceReader | undefined,
    durable: boolean,
  ): Promise<SettledResource> {
    if (!reader) return this.finish(agentId, resourceId, {
      status: 'unavailable', reason: 'Provider does not expose a resource reader.',
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const result = await reader(readLocator);
        if (result.status === 'unavailable') {
          return this.finish(agentId, resourceId, { status: 'unavailable', reason: result.reason });
        }
        if (result.bytes.byteLength === 0) {
          return this.finish(agentId, resourceId, {
            status: 'failed', message: 'Resource is empty.', retryable: false,
          });
        }
        if (result.bytes.byteLength > this.maxBytes) {
          return this.finish(agentId, resourceId, {
            status: 'failed', message: 'Resource exceeds the configured byte limit.', retryable: false,
          });
        }
        const detectedMediaType = detectMediaType(result.bytes);
        if (normalizeMediaType(result.mediaType) !== detectedMediaType) {
          return this.finish(agentId, resourceId, {
            status: 'failed', message: 'Declared media type does not match the resource bytes.', retryable: false,
          });
        }
        const sha256 = createHash('sha256').update(result.bytes).digest('hex');
        this.options.store.putBlob({ sha256, mediaType: detectedMediaType, bytes: result.bytes });
        const existing = this.options.store.findAvailableRecord(agentId, normalizedLocator, sha256);
        if (existing) {
          this.options.store.deleteRecord(agentId, resourceId);
          this.alias(agentId, resourceId, existing.resourceId);
          return { resourceId: existing.resourceId, state: existing.state };
        }
        const imageDimensions = readImageDimensions(result.bytes, detectedMediaType);
        const available: StoredResourceState = {
          ...(imageDimensions ? { imageDimensions } : {}),
          status: 'available', mediaType: detectedMediaType, byteLength: result.bytes.byteLength, sha256,
        };
        const key = this.options.resourceIdKey;
        if (key === undefined) return this.finish(agentId, resourceId, available);
        // The record the acquisition began with has a random id; the settled resource takes the stable one.
        const stableId = stableResourceId(key, agentId, normalizedLocator, sha256);
        const provisional = this.options.store.getRecord(agentId, resourceId);
        // A restore of this id may be waiting for these very bytes; it keeps its record and takes the state.
        if (this.options.store.getRecord(agentId, stableId)) this.options.store.updateRecordState(agentId, stableId, available);
        else this.options.store.createRecord({ resourceId: stableId, agentId, locator: provisional?.locator ?? normalizedLocator, normalizedLocator, state: available });
        this.options.store.deleteRecord(agentId, resourceId);
        this.alias(agentId, resourceId, stableId);
        if (durable) this.options.resourceIdIndex?.put({ agentId, resourceId: stableId, normalizedLocator, readLocator, sha256 });
        return { resourceId: stableId, state: available };
      } catch {
        if (attempt === this.maxAttempts) {
          return this.finish(agentId, resourceId, {
            status: 'failed', message: 'Resource acquisition failed.', retryable: true,
          });
        }
      }
    }
    throw new Error('Resource acquisition attempts exhausted without a result.');
  }

  private alias(agentId: string, provisionalId: string, settledId: string): void {
    if (provisionalId === settledId) return;
    this.aliases.set(`${agentId}\0${provisionalId}`, settledId);
    if (this.aliases.size > MAX_ALIASES) this.aliases.delete(this.aliases.keys().next().value!);
  }

  private finish(agentId: string, resourceId: string, state: StoredResourceState): SettledResource {
    this.options.store.updateRecordState(agentId, resourceId, state);
    return { resourceId, state };
  }

  private availableResponse(state: Extract<StoredResourceState, { status: 'available' }>): ResourceResponse['payload']['state'] {
    const blob = this.options.store.getBlob(state.sha256);
    if (!blob) return { status: 'unavailable', reason: 'Durable resource bytes are missing.' };
    const sha256 = createHash('sha256').update(blob.bytes).digest('hex');
    if (sha256 !== state.sha256 || blob.sha256 !== state.sha256 || blob.mediaType !== state.mediaType) {
      return { status: 'unavailable', reason: 'Durable resource bytes failed integrity validation.' };
    }
    return {
      status: 'available',
      mediaType: blob.mediaType,
      byteLength: blob.bytes.byteLength,
      sha256,
      contentBase64: Buffer.from(blob.bytes).toString('base64'),
      ...(state.imageDimensions ? { imageDimensions: state.imageDimensions } : {}),
    };
  }
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}
