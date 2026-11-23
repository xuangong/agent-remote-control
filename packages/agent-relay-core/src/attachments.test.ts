import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ATTACHMENT_CHUNK_BYTES } from '@orchardworks/agent-remote-protocol';
import { memoryAttachmentStorage, PortableAttachmentStore } from './attachments.js';

const CHUNK = ATTACHMENT_CHUNK_BYTES;
const content = (size: number) => Buffer.from(Array.from({ length: size }, (_, index) => index % 251));
const declare = (bytes: Buffer, name = 'fix.patch') => ({ name, mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
function fixture(limits: { quotaBytes?: number } = {}) {
  let now = 1000;
  const store = new PortableAttachmentStore(memoryAttachmentStorage(), { ...limits, now: () => now });
  const upload = async (bytes: Buffer, name?: string) => {
    const { id } = await store.begin(declare(bytes, name));
    for (let offset = 0; offset < bytes.length; offset += CHUNK) await store.chunk(id, offset, bytes.subarray(offset, offset + CHUNK));
    return store.finish(id);
  };
  const download = async (id: string) => {
    const parts: Buffer[] = [];
    for (let offset = 0; ; offset += CHUNK) { const read = await store.read(id, offset); parts.push(Buffer.from(read.bytes)); if (offset + CHUNK >= read.attachment.byteLength) break; }
    return Buffer.concat(parts);
  };
  return { store, upload, download, advance: (ms: number) => { now += ms; } };
}

describe('the files bots attach', () => {
  it('keeps a file of several chunks and returns the same bytes with its record', async () => {
    const f = fixture(), bytes = content(CHUNK * 2 + 17);
    const file = await f.upload(bytes);
    expect(file).toEqual({ ...declare(bytes), id: expect.stringMatching(/^a_[0-9a-f]{32}$/) });
    expect(await f.store.metadata(file.id)).toEqual(file);
    expect(await f.download(file.id)).toEqual(bytes);
    expect(await f.download((await f.upload(Buffer.alloc(0), 'empty.log')).id)).toEqual(Buffer.alloc(0));
  });

  it('takes chunks in order, once each, and a chunk sent again only when it is the same', async () => {
    const f = fixture(), bytes = content(CHUNK * 2), { id } = await f.store.begin(declare(bytes));
    await expect(f.store.chunk(id, CHUNK, bytes.subarray(CHUNK))).rejects.toThrow('starts where the previous one ended');
    expect(await f.store.chunk(id, 0, bytes.subarray(0, CHUNK))).toEqual({ offset: CHUNK });
    expect(await f.store.chunk(id, 0, bytes.subarray(0, CHUNK))).toEqual({ offset: CHUNK });
    await expect(f.store.chunk(id, 0, Buffer.alloc(CHUNK, 1))).rejects.toThrow('differs');
    await expect(f.store.chunk(id, CHUNK, bytes.subarray(CHUNK, CHUNK + 5))).rejects.toThrow('Invalid file chunk');
    await expect(f.store.finish(id)).rejects.toThrow('incomplete');
    await expect(f.store.metadata(id)).rejects.toThrow('not finished');
    await f.store.chunk(id, CHUNK, bytes.subarray(CHUNK));
    expect((await f.store.finish(id)).byteLength).toBe(bytes.length);
    await expect(f.store.chunk(id, CHUNK, bytes.subarray(CHUNK))).rejects.toThrow('finished');
  });

  it('drops an upload whose bytes do not match the declared hash', async () => {
    const f = fixture(), bytes = content(100), { id } = await f.store.begin({ ...declare(bytes), sha256: 'b'.repeat(64) });
    await f.store.chunk(id, 0, bytes);
    await expect(f.store.finish(id)).rejects.toThrow('do not match');
    await expect(f.store.metadata(id)).rejects.toThrow('no longer stored');
  });

  it('refuses a file over the size limit, a name with a path, and a full storage', async () => {
    const f = fixture({ quotaBytes: 1000 });
    await expect(f.store.begin({ ...declare(content(10)), byteLength: 8 * 1024 * 1024 + 1 })).rejects.toThrow('cannot be attached');
    await expect(f.store.begin(declare(content(10), '../escape.patch'))).rejects.toThrow('cannot be attached');
    await f.upload(content(600));
    await expect(f.store.begin(declare(content(600)))).rejects.toThrow('storage is full');
  });

  it('forgets an unfinished upload after an hour and a file after a day, and makes room for new ones', async () => {
    const f = fixture({ quotaBytes: 1000 });
    const draft = (await f.store.begin(declare(content(600)))).id, kept = await f.upload(content(300));
    f.advance(61 * 60_000);
    await expect(f.store.chunk(draft, 0, content(600))).rejects.toThrow('no longer stored');
    expect(await f.store.metadata(kept.id)).toEqual(kept);
    f.advance(24 * 60 * 60_000);
    await expect(f.store.read(kept.id, 0)).rejects.toThrow('no longer stored');
    await f.upload(content(900));
  });
});
