/**
 * The files bots attach to messages (bots design 3.4). The Relay keeps their bytes for a day in a key-value storage of its own, apart
 * from the Teams: a sender uploads a file in order in chunks and finishes it, the Relay checks its size and sha256, and a receiver
 * reads it back chunk by chunk. Nothing here knows who may read a file: an id names one only to a bot a message told it to.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ATTACHMENT_CHUNK_BYTES, ATTACHMENT_LIMIT_BYTES, isBotAttachment, type BotAttachment } from '@orchardworks/agent-remote-protocol';

/** Opaque keys with values of at most one chunk. */
export interface AttachmentStorage {
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
export interface AttachmentStore {
  /** Starts an upload of a file as declared; the id names it from now on. */
  begin(declaration: Omit<BotAttachment, 'id'>): Promise<{ id: string; offset: number }>;
  /** Adds the next chunk, which starts where the last one ended; a chunk already accepted is accepted again. */
  chunk(id: string, offset: number, bytes: Uint8Array): Promise<{ offset: number }>;
  /** Completes an upload whose bytes are all in and match the declared size and hash. */
  finish(id: string): Promise<BotAttachment>;
  /** A completed file's record. */
  metadata(id: string): Promise<BotAttachment>;
  /** The chunk of a completed file at an offset (a multiple of the chunk size); empty at its end. */
  read(id: string, offset: number): Promise<{ attachment: BotAttachment; offset: number; bytes: Uint8Array }>;
}
export interface AttachmentLimits { quotaBytes?: number; draftTtlMs?: number; fileTtlMs?: number; now?: () => number }
interface Manifest { attachment: BotAttachment; offset: number; createdAt: number; completedAt?: number }

export const ATTACHMENT_QUOTA_BYTES = 128 * 1024 * 1024;
const FILE_COUNT_LIMIT = 512;
const fail = (message: string): never => { throw new Error(message); };

/** Keeps the bytes in memory: a Relay without a state file, and tests. */
export function memoryAttachmentStorage(): AttachmentStorage {
  const items = new Map<string, Uint8Array>();
  return { get: async key => items.get(key), put: async (key, value) => { items.set(key, new Uint8Array(value)); }, delete: async key => { items.delete(key); },
    list: async prefix => [...items.keys()].filter(key => key.startsWith(prefix)).sort() };
}

export class PortableAttachmentStore implements AttachmentStore {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly quota: number;
  private readonly draftTtl: number;
  private readonly fileTtl: number;
  constructor(private readonly storage: AttachmentStorage, limits: AttachmentLimits = {}) {
    this.now = limits.now ?? Date.now; this.quota = limits.quotaBytes ?? ATTACHMENT_QUOTA_BYTES;
    this.draftTtl = limits.draftTtlMs ?? 60 * 60_000; this.fileTtl = limits.fileTtlMs ?? 24 * 60 * 60_000;
  }
  private serial<T>(run: () => Promise<T>): Promise<T> { const pending = this.tail.then(run); this.tail = pending.catch(() => undefined); return pending; }
  private expired(item: Manifest): boolean { return this.now() - (item.completedAt ?? item.createdAt) > (item.completedAt === undefined ? this.draftTtl : this.fileTtl); }
  private async manifests(): Promise<Manifest[]> {
    const items: Manifest[] = [];
    for (const key of await this.storage.list('manifest:')) { const bytes = await this.storage.get(key); if (bytes) items.push(JSON.parse(Buffer.from(bytes).toString('utf8')) as Manifest); }
    return items;
  }
  private async load(id: string): Promise<Manifest> {
    const bytes = await this.storage.get(`manifest:${id}`);
    const item = bytes ? JSON.parse(Buffer.from(bytes).toString('utf8')) as Manifest : undefined;
    if (!item || this.expired(item)) return fail('That file is no longer stored; attach it again.');
    return item;
  }
  private save(item: Manifest): Promise<void> { return this.storage.put(`manifest:${item.attachment.id}`, Buffer.from(JSON.stringify(item))); }
  private async remove(item: Manifest): Promise<void> {
    for (const key of await this.storage.list(`chunk:${item.attachment.id}:`)) await this.storage.delete(key);
    await this.storage.delete(`manifest:${item.attachment.id}`);
  }
  begin(declaration: Omit<BotAttachment, 'id'>): Promise<{ id: string; offset: number }> {
    return this.serial(async () => {
      const attachment = { ...declaration, id: `a_${randomUUID().replaceAll('-', '')}` };
      if (!isBotAttachment(attachment)) fail(`That file cannot be attached: it needs a plain name and at most ${ATTACHMENT_LIMIT_BYTES / 1024 / 1024} MiB.`);
      const all = await this.manifests(), kept: Manifest[] = [];
      for (const item of all) if (this.expired(item)) await this.remove(item); else kept.push(item);
      if (kept.length >= FILE_COUNT_LIMIT || kept.reduce((total, item) => total + item.attachment.byteLength, 0) + attachment.byteLength > this.quota) fail('The Relay\'s file storage is full; try again later.');
      await this.save({ attachment, offset: 0, createdAt: this.now() });
      return { id: attachment.id, offset: 0 };
    });
  }
  chunk(id: string, offset: number, bytes: Uint8Array): Promise<{ offset: number }> {
    return this.serial(async () => {
      const item = await this.load(id), size = item.attachment.byteLength;
      if (item.completedAt !== undefined) fail('That upload is finished.');
      const last = offset + bytes.length === size;
      if (!Number.isSafeInteger(offset) || offset % ATTACHMENT_CHUNK_BYTES !== 0 || !bytes.length || bytes.length > ATTACHMENT_CHUNK_BYTES || offset + bytes.length > size || !last && bytes.length !== ATTACHMENT_CHUNK_BYTES) fail('Invalid file chunk.');
      if (offset < item.offset) {
        const stored = await this.storage.get(`chunk:${id}:${offset}`);
        if (stored && Buffer.from(stored).equals(bytes)) return { offset: item.offset };
        return fail('That chunk differs from the one accepted before.');
      }
      if (offset !== item.offset) fail('A chunk starts where the previous one ended.');
      await this.storage.put(`chunk:${id}:${offset}`, bytes);
      item.offset += bytes.length; await this.save(item);
      return { offset: item.offset };
    });
  }
  finish(id: string): Promise<BotAttachment> {
    return this.serial(async () => {
      const item = await this.load(id);
      if (item.completedAt !== undefined) return item.attachment;
      if (item.offset !== item.attachment.byteLength) fail('The upload is incomplete.');
      const digest = createHash('sha256');
      for (let offset = 0; offset < item.attachment.byteLength; offset += ATTACHMENT_CHUNK_BYTES) digest.update(await this.storage.get(`chunk:${id}:${offset}`) ?? fail('The upload lost bytes.'));
      if (digest.digest('hex') !== item.attachment.sha256) { await this.remove(item); fail('The bytes do not match the declared sha256; the upload was dropped.'); }
      item.completedAt = this.now(); await this.save(item);
      return item.attachment;
    });
  }
  metadata(id: string): Promise<BotAttachment> {
    return this.serial(async () => { const item = await this.load(id); return item.completedAt === undefined ? fail('That upload is not finished.') : item.attachment; });
  }
  read(id: string, offset: number): Promise<{ attachment: BotAttachment; offset: number; bytes: Uint8Array }> {
    return this.serial(async () => {
      const item = await this.load(id), size = item.attachment.byteLength;
      if (item.completedAt === undefined) fail('That upload is not finished.');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || offset % ATTACHMENT_CHUNK_BYTES !== 0) fail('Invalid file offset.');
      const bytes = offset === size ? new Uint8Array() : await this.storage.get(`chunk:${id}:${offset}`) ?? fail('The file lost bytes.');
      return { attachment: item.attachment, offset, bytes };
    });
  }
}
