import { createHash, randomUUID } from 'node:crypto';

import type { AgentResourceReadResult } from '@agent-remote-controller/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type ResourceBinding,
  type ResourceResponse,
  type ResourceState,
} from '@agent-remote-controller/agent-remote-protocol';

import { normalizeFileLocator } from './markdown-locators.js';
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
}

interface SettledResource {
  resourceId: string;
  state: StoredResourceState;
}

export class ResourceIngestor {
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
    )
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, { resourceId, settled });
    return this.acquisition(input.locator, resourceId, settled);
  }

  readResponse(requestId: string, agentId: string, resourceId: string): ResourceResponse {
    return {
      protocolVersion: PROTOCOL_VERSION,
      type: 'resource_response',
      payload: {
        requestId,
        agentId,
        resourceId,
        state: this.readResponseState(agentId, resourceId),
      },
    };
  }

  readState(agentId: string, resourceId: string): ResourceState {
    const state = this.readResponseState(agentId, resourceId);
    if (state.status !== 'available') return state;
    return {
      status: 'available',
      mediaType: state.mediaType,
      byteLength: state.byteLength,
      sha256: state.sha256,
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
          return { resourceId: existing.resourceId, state: existing.state };
        }
        return this.finish(agentId, resourceId, {
          status: 'available', mediaType: detectedMediaType, byteLength: result.bytes.byteLength, sha256,
        });
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
    };
  }
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function detectMediaType(bytes: Uint8Array): string {
  if (startsWith(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (startsWith(bytes, [255, 216, 255])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [80, 75, 3, 4])) return 'application/zip';

  const text = decodeUtf8(bytes);
  if (text === undefined) return 'application/octet-stream';
  const trimmed = text.trimStart();
  if (/^<svg(?:\s|>)/i.test(trimmed)) return 'image/svg+xml';
  if (/^<!doctype\s+html|^<html(?:\s|>)/i.test(trimmed)) return 'text/html';
  if (looksLikeJson(trimmed)) return 'application/json';
  return 'text/plain';
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function looksLikeJson(value: string): boolean {
  if (!value.startsWith('{') && !value.startsWith('[')) return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
