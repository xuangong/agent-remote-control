import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PortableAttachmentStore } from '@orchardworks/agent-relay-core';
import { ATTACHMENT_CHUNK_BYTES } from '@orchardworks/agent-remote-protocol';
import { FileAttachmentStorage } from './attachment-storage.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

it('keeps a bot\'s file in a directory of its own across a reopened store, and lists, reads and deletes keys by name', async () => {
  const directory = join(await mkdtemp(join(tmpdir(), 'attachments-')), 'account');
  directories.push(directory);
  const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES + 3, 'log line\n');
  const { id } = await new PortableAttachmentStore(new FileAttachmentStorage(directory)).begin({ name: 'build.log', mediaType: 'text/plain', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const open = () => new PortableAttachmentStore(new FileAttachmentStorage(directory));
  await open().chunk(id, 0, bytes.subarray(0, ATTACHMENT_CHUNK_BYTES));
  await open().chunk(id, ATTACHMENT_CHUNK_BYTES, bytes.subarray(ATTACHMENT_CHUNK_BYTES));
  expect((await open().finish(id)).byteLength).toBe(bytes.length);
  expect(Buffer.from((await open().read(id, ATTACHMENT_CHUNK_BYTES)).bytes)).toEqual(bytes.subarray(ATTACHMENT_CHUNK_BYTES));
  const storage = new FileAttachmentStorage(directory);
  expect(await storage.list('manifest:')).toEqual([`manifest:${id}`]);
  expect(await storage.list('chunk:')).toHaveLength(2);
  await storage.delete(`manifest:${id}`);
  expect(await storage.get(`manifest:${id}`)).toBeUndefined();
  expect(await new FileAttachmentStorage(join(directory, 'missing')).list('manifest:')).toEqual([]);
  expect((await readdir(directory)).every(name => !name.includes('/'))).toBe(true);
  await expect(storage.get('')).rejects.toThrow('Invalid attachment storage key');
});
