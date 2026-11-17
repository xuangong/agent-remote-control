import { createHash } from 'node:crypto';
import type { ImageDimensions } from '@orchardworks/agent-remote-protocol';

export type StoredResourceState =
  | { status: 'pending'; retryAfterMs: number }
  | { status: 'available'; mediaType: string; byteLength: number; sha256: string; imageDimensions?: ImageDimensions }
  | { status: 'failed'; message: string; retryable: boolean }
  | { status: 'unavailable'; reason: string };

export interface StoredResourceRecord {
  resourceId: string;
  agentId: string;
  locator: string;
  normalizedLocator: string;
  state: StoredResourceState;
}

export interface StoredResourceBlob {
  sha256: string;
  mediaType: string;
  byteLength: number;
  bytes: Uint8Array;
}

export interface ResourceStore {
  createRecord(record: StoredResourceRecord): void;
  deleteRecord(agentId: string, resourceId: string): void;
  updateRecordState(agentId: string, resourceId: string, state: StoredResourceState): void;
  getRecord(agentId: string, resourceId: string): StoredResourceRecord | undefined;
  findAvailableRecord(agentId: string, normalizedLocator: string, sha256: string): StoredResourceRecord | undefined;
  putBlob(blob: Omit<StoredResourceBlob, 'byteLength'>): void;
  getBlob(sha256: string): StoredResourceBlob | undefined;
}

export class InMemoryResourceStore implements ResourceStore {
  private readonly records = new Map<string, StoredResourceRecord>();
  private readonly blobs = new Map<string, StoredResourceBlob>();

  createRecord(record: StoredResourceRecord): void {
    if (this.records.has(record.resourceId)) throw new Error('Resource identity already exists.');
    this.records.set(record.resourceId, structuredClone(record));
  }

  deleteRecord(agentId: string, resourceId: string): void {
    const record = this.records.get(resourceId);
    if (!record || record.agentId !== agentId) throw new Error('Resource record was not found.');
    this.records.delete(resourceId);
  }

  updateRecordState(agentId: string, resourceId: string, state: StoredResourceState): void {
    const record = this.records.get(resourceId);
    if (!record || record.agentId !== agentId) throw new Error('Resource record was not found.');
    record.state = structuredClone(state);
  }

  getRecord(agentId: string, resourceId: string): StoredResourceRecord | undefined {
    const record = this.records.get(resourceId);
    return record?.agentId === agentId ? structuredClone(record) : undefined;
  }

  findAvailableRecord(agentId: string, normalizedLocator: string, sha256: string): StoredResourceRecord | undefined {
    for (const record of this.records.values()) {
      if (
        record.agentId === agentId
        && record.normalizedLocator === normalizedLocator
        && record.state.status === 'available'
        && record.state.sha256 === sha256
      ) return structuredClone(record);
    }
    return undefined;
  }

  putBlob(blob: Omit<StoredResourceBlob, 'byteLength'>): void {
    const sha256 = createHash('sha256').update(blob.bytes).digest('hex');
    if (sha256 !== blob.sha256) throw new Error('Resource bytes do not match their SHA-256 identity.');
    const existing = this.blobs.get(sha256);
    if (existing) {
      if (existing.mediaType !== blob.mediaType || !Buffer.from(existing.bytes).equals(Buffer.from(blob.bytes))) {
        throw new Error('Immutable resource blob conflicts with existing content.');
      }
      return;
    }
    this.blobs.set(sha256, {
      sha256,
      mediaType: blob.mediaType,
      byteLength: blob.bytes.byteLength,
      bytes: Uint8Array.from(blob.bytes),
    });
  }

  getBlob(sha256: string): StoredResourceBlob | undefined {
    const blob = this.blobs.get(sha256);
    if (!blob) return undefined;
    return { ...blob, bytes: Uint8Array.from(blob.bytes) };
  }
}
