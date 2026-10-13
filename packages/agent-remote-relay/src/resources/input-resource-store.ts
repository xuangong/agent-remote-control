import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, open, writeFile, chmod } from 'node:fs/promises';
import { atomicWriteFile } from '@orchardworks/agent-platform';
import { basename, join } from 'node:path';
import { RESOURCE_INPUT_CAPABILITIES, type AgentInputPart, type AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import type { ResourceUploadReceipt, ResourceMetadata, MessagePart } from '@orchardworks/agent-remote-protocol';

export interface InputResourceStoreOptions {
  directory: string;
  quotaBytes?: number;
  draftTtlMs?: number;
  now?: () => number;
}
export interface ResourceUploadDeclaration { uploadId: string; sha256: string; byteLength: number; mediaType: string; name: string }
export interface ResourceUploadChunk { uploadId: string; offset: number; contentBase64: string }
interface Manifest extends ResourceUploadDeclaration {
  version: 1;
  key: string;
  scopeHash: string;
  resourceId: string;
  offset: number;
  touchedAt: number;
  pinned: boolean;
  resource?: NonNullable<ResourceUploadReceipt['resource']>;
}

export class InputResourceError extends Error {
  constructor(message: string) { super(message); this.name = 'InputResourceError'; }
}

/** Durable, session-scoped incoming resources. All disk paths are generated internally. */
export class InputResourceStore {
  private readonly manifests = new Map<string, Manifest>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly quotaBytes: number;
  private readonly draftTtlMs: number;

  constructor(private readonly options: InputResourceStoreOptions) {
    this.now = options.now ?? Date.now;
    this.quotaBytes = options.quotaBytes ?? 1024 * 1024 * 1024;
    this.draftTtlMs = options.draftTtlMs ?? 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.quotaBytes) || this.quotaBytes < 1 || !Number.isFinite(this.draftTtlMs) || this.draftTtlMs <= 0) throw new InputResourceError('Invalid resource storage limits.');
    this.ready = this.restore();
    void this.ready.catch(() => undefined);
  }

  begin(scope: string, declaration: ResourceUploadDeclaration): Promise<ResourceUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      if (!scope || !declaration.uploadId || declaration.uploadId.length > 256 || !/^[a-f0-9]{64}$/.test(declaration.sha256)
        || !Number.isSafeInteger(declaration.byteLength) || declaration.byteLength < 0 || declaration.byteLength > RESOURCE_INPUT_CAPABILITIES.maxResourceBytes
        || !validDisplay(declaration.name) || !validDisplay(declaration.mediaType)) throw new InputResourceError('Invalid or unsupported resource upload declaration. Maximum size: 50 MiB.');
      const key = digest(JSON.stringify([scope, declaration.uploadId]));
      const existing = this.manifests.get(key);
      if (existing) {
        if (existing.sha256 !== declaration.sha256 || existing.byteLength !== declaration.byteLength || existing.mediaType !== declaration.mediaType || existing.name !== declaration.name) throw new InputResourceError('Upload identity conflicts with previously accepted resource.');
        await this.touch(existing);
        return receipt(existing);
      }
      if (this.manifests.size >= 10000) throw new InputResourceError('Resource storage entry quota exceeded.');
      const reserved = [...this.manifests.values()].reduce((total, item) => total + item.byteLength, 0);
      if (reserved + declaration.byteLength > this.quotaBytes) throw new InputResourceError('Resource storage quota exceeded. Retained history resources will not be deleted.');
      const manifest: Manifest = { ...declaration, version: 1, key, scopeHash: digest(scope), resourceId: randomUUID(), offset: 0, touchedAt: this.now(), pinned: false };
      await writeFile(this.path(key, 'part'), new Uint8Array(), { mode: 0o600 });
      await this.persist(manifest);
      this.manifests.set(key, manifest);
      return receipt(manifest);
    });
  }

  chunk(scope: string, chunk: ResourceUploadChunk): Promise<ResourceUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      const manifest = this.requireUpload(scope, chunk.uploadId);
      if (!Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || typeof chunk.contentBase64 !== 'string' || chunk.contentBase64.length > 43692 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.contentBase64)) throw new InputResourceError('Invalid resource chunk encoding or offset.');
      const bytes = Buffer.from(chunk.contentBase64, 'base64');
      if (bytes.length < 1 || bytes.length > 32 * 1024 || bytes.toString('base64') !== chunk.contentBase64 || chunk.offset + bytes.length > manifest.byteLength) throw new InputResourceError('Resource chunks must contain at most 32 KiB within the declared resource length.');
      if (chunk.offset < manifest.offset || manifest.resource) {
        const accepted = await readFile(this.path(manifest.key, manifest.resource ? 'resource' : 'part'));
        if (chunk.offset + bytes.length > manifest.offset || !accepted.subarray(chunk.offset, chunk.offset + bytes.length).equals(bytes)) throw new InputResourceError('Resource chunk conflicts with accepted bytes.');
      } else {
        if (chunk.offset !== manifest.offset) throw new InputResourceError(`Resource chunk must resume at offset ${manifest.offset}.`);
        const file = await open(this.path(manifest.key, 'part'), 'r+');
        try {
          let written = 0;
          while (written < bytes.length) {
            const result = await file.write(bytes, written, bytes.length - written, manifest.offset + written);
            if (!result.bytesWritten) throw new InputResourceError('Resource chunk write was incomplete.');
            written += result.bytesWritten;
          }
          await file.sync();
        } finally { await file.close(); }
        manifest.offset += bytes.length;
      }
      await this.touch(manifest);
      return receipt(manifest);
    });
  }

  finish(scope: string, uploadId: string): Promise<ResourceUploadReceipt> {
    return this.serial(async () => {
      await this.expire();
      const manifest = this.requireUpload(scope, uploadId);
      if (manifest.resource) { await this.touch(manifest); return receipt(manifest); }
      if (manifest.offset !== manifest.byteLength) throw new InputResourceError('Resource upload is incomplete.');
      let bytes: Buffer;
      try { bytes = await readFile(this.path(manifest.key, 'part')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; bytes = await readFile(this.path(manifest.key, 'resource')); }
      if (bytes.length !== manifest.byteLength || digest(bytes) !== manifest.sha256) throw new InputResourceError('Resource bytes do not match their declared length or SHA-256 digest.');
      try { await rename(this.path(manifest.key, 'part'), this.path(manifest.key, 'resource')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await chmod(this.path(manifest.key, 'resource'), 0o400);
      manifest.resource = { resourceId: manifest.resourceId, sha256: manifest.sha256, byteLength: manifest.byteLength, mediaType: manifest.mediaType, name: manifest.name };
      await this.touch(manifest);
      return receipt(manifest);
    });
  }

  /** Pin before native dispatch: an error may still mean the native runtime accepted input. */
  resolveAndPin(scope: string, parts: readonly MessagePart[]): Promise<AgentInputPart[]> {
    return this.serial(async () => {
      await this.expire();
      if (!parts.length) throw new InputResourceError('Message content must not be empty.');
      const resources = parts.filter(part => part.type === 'resource');
      if (resources.length > RESOURCE_INPUT_CAPABILITIES.maxResources) throw new InputResourceError('A message may contain at most 8 resources.');
      const resolved = resources.map(part => this.requireResource(scope, part.resourceId));
      const unique = new Map(resolved.map(item => [item.sha256, item]));
      if ([...unique.values()].reduce((sum, item) => sum + item.byteLength, 0) > RESOURCE_INPUT_CAPABILITIES.maxMessageBytes) throw new InputResourceError('Combined resource content exceeds 100 MiB.');
      for (const item of unique.values()) {
        const bytes = await readFile(this.path(item.key, 'resource'));
        if (bytes.length !== item.byteLength || digest(bytes) !== item.sha256) throw new InputResourceError('Stored resource integrity verification failed.');
      }
      for (const item of new Set(resolved)) { item.pinned = true; await this.touch(item); }
      return parts.map(part => {
        if (part.type === 'text') return { ...part };
        if (part.type !== 'resource') throw new InputResourceError('Expected text or resource input.');
        const item = this.requireResource(scope, part.resourceId);
        return { type: 'resource', resourceId: item.resourceId, path: this.path(item.key, 'resource'), mediaType: item.mediaType, name: item.name, byteLength: item.byteLength, sha256: item.sha256, label: part.label };
      });
    });
  }

  read(scope: string, locator: string): Promise<AgentResourceReadResult> {
    return this.serial(async () => {
      await this.expire();
      const prefix = 'input-resource:';
      if (!locator.startsWith(prefix)) return { status: 'unavailable', reason: 'Resource was not found in this session.' };
      const item = [...this.manifests.values()].find(record => record.scopeHash === digest(scope) && record.resourceId === locator.slice(prefix.length) && record.resource);
      if (!item) return { status: 'unavailable', reason: 'Resource was not found in this session.' };
      const bytes = await readFile(this.path(item.key, 'resource'));
      if (digest(bytes) !== item.sha256) return { status: 'unavailable', reason: 'Stored resource integrity verification failed.' };
      await this.touch(item);
      return { status: 'available', bytes, mediaType: item.mediaType };
    });
  }

  getMetadata(scope: string, resourceId: string): Promise<ResourceMetadata> {
    return this.serial(async () => { await this.expire(); const item = this.requireResource(scope, resourceId); await this.touch(item); return structuredClone(item.resource!); });
  }

  pin(scope: string, resourceId: string): Promise<void> {
    return this.serial(async () => { await this.expire(); const item = this.requireResource(scope, resourceId); item.pinned = true; await this.touch(item); });
  }

  readChunk(scope: string, resourceId: string, offset: number): Promise<ResourceMetadata & { offset: number; contentBase64: string }> {
    return this.serial(async () => {
      await this.expire();
      const item = this.requireResource(scope, resourceId);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > item.byteLength) throw new InputResourceError('Invalid resource download offset.');
      const file = await open(this.path(item.key, 'resource'), 'r');
      try {
        if ((await file.stat()).size !== item.byteLength) throw new InputResourceError('Stored resource length changed.');
        const bytes = Buffer.alloc(Math.min(32768, item.byteLength - offset));
        const result = await file.read(bytes, 0, bytes.length, offset);
        if (result.bytesRead !== bytes.length) throw new InputResourceError('Stored resource read was incomplete.');
        await this.touch(item);
        return { ...item.resource!, offset, contentBase64: bytes.toString('base64') };
      } finally { await file.close(); }
    });
  }

  async importLocal(scope: string, path: string, options: { uploadId?: string; name?: string; mediaType?: string } = {}): Promise<ResourceMetadata> {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > RESOURCE_INPUT_CAPABILITIES.maxResourceBytes) throw new InputResourceError('A resource must be a regular file of at most 50 MiB.');
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new InputResourceError('Resource changed during import.');
        offset += result.bytesRead;
      }
      if ((await file.stat()).size !== bytes.length) throw new InputResourceError('Resource changed during import.');
    } finally { await file.close(); }
    const uploadId = options.uploadId ?? randomUUID();
    const initial = await this.begin(scope, { uploadId, name: options.name ?? basename(path), mediaType: options.mediaType ?? 'application/octet-stream', byteLength: bytes.length, sha256: digest(bytes) });
    for (let offset = initial.offset; offset < bytes.length; offset += 32768) await this.chunk(scope, { uploadId, offset, contentBase64: bytes.subarray(offset, offset + 32768).toString('base64') });
    return (await this.finish(scope, uploadId)).resource!;
  }

  private path(key: string, extension: string): string { return join(this.options.directory, `${key}.${extension}`); }
  private async restore(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.options.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const item = JSON.parse(await readFile(join(this.options.directory, name), 'utf8')) as Manifest;
      if (item.version !== 1 || `${item.key}.json` !== name || !/^[a-f0-9]{64}$/.test(item.scopeHash)) throw new InputResourceError('Resource storage manifest is invalid.');
      this.manifests.set(item.key, item);
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => { await this.ready; return work(); });
    this.tail = next.catch(() => undefined);
    return next;
  }
  private requireUpload(scope: string, uploadId: string): Manifest {
    const item = this.manifests.get(digest(JSON.stringify([scope, uploadId])));
    if (!item) throw new InputResourceError('Resource upload was not found or has expired in this session.');
    return item;
  }
  private requireResource(scope: string, resourceId: string): Manifest {
    const item = [...this.manifests.values()].find(record => record.scopeHash === digest(scope) && record.resourceId === resourceId && record.resource);
    if (!item) throw new InputResourceError('Resource was not found, is incomplete, or belongs to another session.');
    return item;
  }
  private async touch(item: Manifest): Promise<void> { item.touchedAt = this.now(); await this.persist(item); }
  private async persist(item: Manifest): Promise<void> {
    await atomicWriteFile(this.path(item.key, 'json'), JSON.stringify(item));
  }
  private async expire(): Promise<void> {
    for (const item of this.manifests.values()) {
      if (item.pinned || this.now() - item.touchedAt < this.draftTtlMs) continue;
      await Promise.all(['part', 'resource', 'json', 'json.tmp'].map(extension => rm(this.path(item.key, extension), { force: true })));
      this.manifests.delete(item.key);
    }
  }
}
function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function receipt(item: Manifest): ResourceUploadReceipt { return { uploadId: item.uploadId, offset: item.offset, ...(item.resource ? { resource: structuredClone(item.resource) } : {}) }; }

function validDisplay(value: string): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\x00-\x1f\x7f]/.test(value); }
