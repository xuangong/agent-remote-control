import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PortableAttachmentStore } from '@orchardworks/agent-relay-core';
import { ATTACHMENT_CHUNK_BYTES } from '@orchardworks/agent-remote-protocol';
import { SqliteAttachmentStorage } from '../src/attachment-storage.js';
import { sqliteStorage } from './sqlite-storage.js';

it('keeps a bot\'s file across a restart, apart from another account\'s, and refuses a record over 128 KiB', async () => {
  const { storage } = sqliteStorage();
  // Each request opens the stores again, as a restarted Durable Object does.
  const open = (namespace = 'owner-a') => new PortableAttachmentStore(new SqliteAttachmentStorage(storage, namespace));
  const bytes = Buffer.alloc(300_007);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { id } = await open().begin({ name: 'diagnostics.bundle', mediaType: 'application/x-git-bundle', byteLength: bytes.length, sha256 });
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) await open().chunk(id, offset, bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES));
  expect((await open().finish(id)).sha256).toBe(sha256);
  const read: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) read.push(Buffer.from((await open().read(id, offset)).bytes));
  expect(Buffer.concat(read)).toEqual(bytes);
  await expect(open('owner-b').metadata(id)).rejects.toThrow('no longer stored');
  const raw = new SqliteAttachmentStorage(storage, 'owner-a');
  await expect(raw.put('big', new Uint8Array(128 * 1024 + 1))).rejects.toThrow(/128 KiB/);
  await expect(raw.get('')).rejects.toThrow(/Invalid attachment storage key/);
});
