import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { ATTACHMENT_CHUNK_BYTES, parseTaskInputs, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { botsHarness } from './test-utils/bots-harness.js';
import { botFiles } from './bot-files.js';
import { BotTools } from './bot-tools.js';

// A chief and a tracker, both bots of one group, in front of a real Relay broker with its file store and a real Controller team runtime.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const groups = [{ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'worker'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'host', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: 'b_' + '1'.repeat(32), name: 'Chief' }, v2: { botId: 'b_' + '2'.repeat(32), name: 'Tracker' } } } }] as never;
const tool = (tools: readonly AgentSessionTool[], name: string) => tools.find(item => item.name === name)!;

async function setup(tamper?: (call: TeamHostCall, result: any) => any) {
  const h = await botsHarness({ tasks: true, groups, sessions: ['tracker'] });
  cleanups.push(() => h.close());
  const downloads = join(h.directory, '.downloads');
  const bots = (title: string) => new BotTools({ request: async call => { const result = await h.host(call); return tamper ? tamper(call, result) : result; }, tasks: () => true, title: async () => title,
    files: botFiles(async () => h.directory, downloads, () => Date.now()) });
  const tools = (id: string, title: string) => bots(title).namespace(() => h.ref('codex', id), false).tools;
  const run = async (tools: readonly AgentSessionTool[], name: string, args: object) => JSON.parse(await tool(tools, name).execute(args) as string);
  return { h, downloads, chief: tools('worker', 'Chief'), tracker: tools('tracker', 'Tracker'), run };
}
const attachedIn = async (h: Awaited<ReturnType<typeof setup>>['h']) => {
  await h.host({ action: 'bot_enablement' });
  h.busy('tracker', false);
  await h.runtime.tick();
  return h.sessions.get('tracker')!.deliveries.flatMap(delivery => parseTaskInputs(delivery.text) ?? []).filter(input => input.kind === 'assistant');
};

describe('files a bot attaches to a message', () => {
  it('goes in chunks from the sender\'s computer, is listed in the message, and is downloaded and verified by the receiver', async () => {
    const { h, downloads, chief, tracker, run } = await setup();
    const bytes = Buffer.alloc(ATTACHMENT_CHUNK_BYTES * 2 + 9, 'patch line\n');
    await mkdir(join(h.directory, 'out'));
    await writeFile(join(h.directory, 'out', 'fix.patch'), bytes);
    const sent = await run(chief, 'message', { to: 'Tracker', text: 'The fix is attached.', attachments: [{ path: 'out/fix.patch' }] });
    expect(sent).toMatchObject({ outcome: 'delivered' });
    const [message] = await attachedIn(h) as Array<{ body: string }>;
    const [, id] = /^- (a_[0-9a-f]{32}) · fix\.patch · text\/x-diff · (\d+) bytes · sha256 ([0-9a-f]{64})$/m.exec(message!.body)!;
    expect(message!.body).toContain(`${bytes.length} bytes · sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
    const got = await run(tracker, 'download_attachment', { attachment: id });
    expect(got).toMatchObject({ name: 'fix.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), verified: true });
    expect(got.path).toBe(join(downloads, id!, 'fix.patch'));
    expect(await readFile(got.path)).toEqual(bytes);
    // Downloaded where only its owner reads it, and nothing was applied to the working directory.
    expect((await stat(got.path)).mode & 0o077).toBe(0);
    expect(await readdir(h.directory)).not.toContain('fix.patch');
  });

  it('is not kept when the bytes the Relay returns do not match what was declared', async () => {
    const f = await setup((call, result) => call.action === 'attachment_read' && result.contentBase64 ? { ...result, contentBase64: Buffer.from('tampered').toString('base64') } : result);
    await writeFile(join(f.h.directory, 'a.log'), 'the real log\n');
    await f.run(f.chief, 'message', { to: 'Tracker', text: 'The log.', attachments: [{ path: 'a.log' }] });
    const [message] = await attachedIn(f.h) as Array<{ body: string }>;
    const id = /(a_[0-9a-f]{32})/.exec(message!.body)![1]!;
    await expect(tool(f.tracker, 'download_attachment').execute({ attachment: id })).rejects.toThrow('does not match its size and sha256');
    expect(await readdir(f.downloads).catch(() => [])).toEqual([]);
  });

  it('refuses what is no file, a file over 8 MiB, and an attachment on a Host without files', async () => {
    const { h, chief, run } = await setup();
    await mkdir(join(h.directory, 'folder'));
    await writeFile(join(h.directory, 'big.bundle'), Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(tool(chief, 'message').execute({ to: 'Tracker', text: 'Look.', attachments: [{ path: 'folder' }] })).rejects.toThrow('is not a file');
    await expect(tool(chief, 'message').execute({ to: 'Tracker', text: 'Look.', attachments: [{ path: 'missing.log' }] })).rejects.toThrow('is not a file');
    await expect(tool(chief, 'message').execute({ to: 'Tracker', text: 'Look.', attachments: [{ path: 'big.bundle' }] })).rejects.toThrow('over 8 MiB');
    const bare = new BotTools({ request: call => h.host(call), tasks: () => true }).namespace(() => h.ref('codex', 'worker'), false).tools;
    await expect(tool(bare, 'message').execute({ to: 'Tracker', text: 'Look.', attachments: [{ path: 'a.log' }] })).rejects.toThrow('not available on this Host');
    expect(await run(chief, 'message', { to: 'Tracker', text: 'Only words.' })).toMatchObject({ outcome: 'delivered' });
  });
});
