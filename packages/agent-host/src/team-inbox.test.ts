import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef, Team, TeamHostCall, TeamMember, TeamMessage } from '@orchardworks/agent-remote-protocol';
import { TeamRuntime, type TeamRuntimeAccess } from './team.js';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'team-inbox-'));
  const member: TeamMember = { id: 'worker', hostId: 'host', providerId: 'fixture', role: 'member', name: 'Worker', responsibility: 'Verify evidence', creation: 'ready', activity: 'busy', summary: '', updatedAt: 1 };
  const team: Team & { receipts: Array<Omit<TeamMessage, 'text' | 'resources'>> } = {
    id: 'team', operationId: 'create', title: 'Work', revision: 1, status: 'active', createdAt: 1, updatedAt: 1,
    source: { hostId: 'host', providerId: 'fixture', nativeSessionId: 'source', title: 'Source' },
    members: [{ ...member, id: 'leader', role: 'leader', name: 'Leader', nativeSessionId: 'leader-session' }, member], messages: [], receipts: [],
  };
  let extensions: AgentSessionExtensions | undefined, current = 'A', frozen = false, release: (() => void) | undefined;
  const calls: TeamHostCall[] = [];
  const ref = (nativeSessionId: string): NativeSessionRef => ({ controllerId: 'controller', providerId: 'fixture', nativeSessionId });
  const access: TeamRuntimeAccess = {
    controllerId: 'controller', available: () => true, supportedProviders: () => ['fixture'],
    sessionRouting: { resolve: anchor => ({ anchor, target: ref(current), operationIds: [] }), assertCurrent: (_anchor, actual) => { if (frozen || actual.nativeSessionId !== current) throw new Error('Recipient is not current.'); } },
    async create(_provider, _cwd, value) { extensions = value; return 'A'; },
    async acquire() { throw new Error('Unexpected native acquisition'); },
    async execute() { throw new Error('Unexpected native operation'); },
  };
  let paused = false;
  const runtime = new TeamRuntime(directory, access, async call => {
    calls.push(call);
    if (paused) await new Promise<void>(resolve => { release = resolve; });
    if (call.action === 'report') member.summary = call.summary;
    if (call.action === 'describe_member') member.responsibility = call.responsibility;
    return structuredClone(team);
  }, 1000000);
  await runtime.create({ teamId: team.id, source: team.source, member });
  return { team, calls, runtime, get extensions() { return extensions!; }, ref,
    setCurrent(value: string) { current = value; }, freeze() { frozen = true; }, pause() { paused = true; }, release() { release?.(); },
    async call(name: string, args: unknown = {}, source = extensions!) { const tool = source.tools!.find(tool => tool.name === name); expect(tool, `Team tool ${name}`).toBeDefined(); return JSON.parse(await tool!.execute(args)); },
    async close() { await runtime.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

it('returns complete incoming pages while keeping outgoing bodies and upload inventory out of tools', async () => {
  const context = await fixture();
  try {
    const resource = { resourceId: 'resource', name: 'evidence.json', mediaType: 'application/json', byteLength: 20, sha256: 'a'.repeat(64) };
    context.team.resourceUploads = [{ ownerMemberId: 'leader', expiresAt: 999999, resource }];
    context.team.messages = [
      ...Array.from({ length: 10 }, (_, index): TeamMessage => ({ id: `incoming-${index}`, from: 'leader', to: 'worker', text: `Evidence ${index}`, createdAt: index + 10, status: 'queued', ...(index === 0 ? { resources: [resource] } : {}) })),
      { id: 'outgoing', from: 'worker', to: 'leader', text: 'Private long outgoing body', createdAt: 30, status: 'queued' },
    ];
    const first = await context.call('read_team');
    expect(first.messages.map((message: TeamMessage) => message.id)).toEqual(['incoming-0', 'incoming-1', 'incoming-2', 'incoming-3', 'incoming-4', 'incoming-5', 'incoming-6', 'incoming-7']);
    expect(first.messages[0]).toMatchObject({ text: 'Evidence 0', resources: [resource] });
    expect(first).toMatchObject({ hasMore: true, nextAfterMessageId: 'incoming-7' });
    expect(first.resourceUploads).toBeUndefined();
    expect(JSON.stringify(first)).not.toContain('Private long outgoing body');
    expect(first.messageStatuses).toEqual([expect.objectContaining({ id: 'outgoing', status: 'queued' })]);
    expect(context.team.messages).toHaveLength(11);
    const acknowledged = context.team.messages.splice(0, 8);
    context.team.receipts = acknowledged.map(({ text: _text, resources: _resources, ...message }) => ({ ...message, status: 'accepted', acceptance: 'handled' }));
    const second = await context.call('read_team', { afterMessageId: first.nextAfterMessageId });
    expect(second.messages.map((message: TeamMessage) => message.id)).toEqual(['incoming-8', 'incoming-9']);
    expect(second.hasMore).toBe(false);
    expect(second.nextAfterMessageId).toBeUndefined();
    await expect(context.call('read_team', { afterMessageId: 'expired' })).rejects.toThrow(/cursor.*read_team/i);
  } finally { await context.close(); }
}, 5000);

it('limits inbox payload without truncating a body or losing the next page', async () => {
  const context = await fixture();
  try {
    context.team.messages = Array.from({ length: 8 }, (_, index) => ({ id: `large-${index}`, from: 'leader', to: 'worker', text: `${index}${'"'.repeat(15999)}`, status: 'queued', createdAt: index }));
    const first = await context.call('read_team');
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0].text).toBe(`0${'"'.repeat(15999)}`);
    expect(first.hasMore).toBe(true);
    const second = await context.call('read_team', { afterMessageId: first.nextAfterMessageId });
    expect(second.messages[0].text).toBe(`1${'"'.repeat(15999)}`);
    const report = await context.call('report_team_progress', { summary: 'Evidence checked' });
    expect(report).toMatchObject({ id: 'team', status: 'active', member: { id: 'worker', summary: 'Evidence checked' } });
    expect(report.messages).toBeUndefined();
    expect(JSON.stringify(report).length).toBeLessThan(2000);
  } finally { await context.close(); }
}, 5000);

it('validates acknowledgement IDs and binds acknowledgements to the current recipient before and after the request', async () => {
  const context = await fixture();
  try {
    const candidate = (await context.runtime.extensions('fixture', 'A', () => 'B'))!;
    await expect(context.call('acknowledge_team_messages', { messageIds: ['seen'] }, candidate)).rejects.toThrow(/current/);
    expect(context.calls).toEqual([]);
    context.setCurrent('B');
    for (const messageIds of [[], ['repeat', 'repeat'], Array.from({ length: 33 }, (_, index) => String(index))]) {
      await expect(context.call('acknowledge_team_messages', { messageIds }, candidate)).rejects.toThrow(/Invalid arguments/);
    }
    expect(context.calls).toEqual([]);
    context.pause();
    const pending = context.call('acknowledge_team_messages', { messageIds: ['seen'] }, candidate);
    await expect.poll(() => context.calls.length, { timeout: 1000 }).toBe(1);
    expect(context.calls[0]).toEqual({ action: 'acknowledge', teamId: 'team', memberId: 'worker', messageIds: ['seen'], expectedNativeSessionId: 'B' });
    context.freeze(); context.release();
    await expect(pending).rejects.toThrow(/current/);
  } finally { context.release(); await context.close(); }
}, 5000);
