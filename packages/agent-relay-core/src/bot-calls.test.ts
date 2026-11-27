import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { attachmentLines, isBotMessageResult, parseTaskInputs, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import type { SavedTeam } from './team-delivery.js';
import { subSessionId } from './chain-scope.js';
import { memoryAttachmentStorage, PortableAttachmentStore } from './attachments.js';
import { instructionsHash } from './inboxes.js';
import type { HostPlace, HostPlaces } from './host-places.js';

// Bots call as their own sessions. The groups and the Hosts are stubs; the broker, tasks, inboxes and their validation are real.
const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32) };
const group = () => ({ window: { id: 'g', title: 'g', revision: 1, views: [['v1', 'chief'], ['v2', 'tracker']].map(([id, nativeSessionId]) => ({ id, placement: 'primary',
  binding: { hostId: 'mac', providerId: 'codex', nativeSessionId, title: nativeSessionId } })) },
  bots: { rank: 'm', members: { v1: { botId: ids.chief, name: 'Chief' }, v2: { botId: ids.tracker, name: 'Tracker' } } } }) as unknown as WindowGroup;

function fixture(places?: HostPlaces, leading: WindowGroup[] = []) {
  let state: SavedTeam[] = [], now = 100, workers = 0, offline = false;
  const groups = [...leading, group()], placed: Array<{ groupId: string; viewId: string; details: Record<string, unknown> }> = [];
  const seats: Array<{ hostId: string; cwd?: string }> = [];
  const broker = new TeamBroker({
    ...(places ? { places } : {}),
    resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    // Drafts as the Relay's state makes them.
    change: async update => { let result: unknown; state = committed.produce(state, draft => { result = structuredClone(detached(update(draft))); }); return result as never; },
    createSeat: async (hostId, seat) => { seats.push({ hostId, ...(seat.member.cwd ? { cwd: seat.member.cwd } : {}) }); return offline ? Promise.reject(new Error('Host offline.')) : ({ ...seat.member, creation: 'ready', activity: 'idle', cwd: seat.member.cwd ?? '/repo', ...(seat.member.nativeSessionId ? {} : { nativeSessionId: `worker-${++workers}` }) }); },
    attachments: new PortableAttachmentStore(memoryAttachmentStorage()),
    tasks: { capable: () => true, assertHost: () => {} },
    assistants: { groups: () => groups, capable: () => true,
      placeBot: async (groupId, view, details) => {
        const target = groups.find(item => item.window.id === groupId)!;
        (target.window.views as unknown[]).push({ id: view.id, placement: 'primary', binding: view.binding });
        target.bots!.members[view.id] = details; placed.push({ groupId, viewId: view.id, details: details as Record<string, unknown> });
      },
      setMission: async (groupId, viewId, mission) => { groups.find(item => item.window.id === groupId)!.bots!.members[viewId] = { ...groups.find(item => item.window.id === groupId)!.bots!.members[viewId], mission }; } },
  });
  const as = (nativeSessionId: string) => ({ providerId: 'codex', nativeSessionId });
  const task = () => state.find(team => team.task)!;
  const inputs = (team: SavedTeam, to: number) => team.messages.filter(message => message.to === team.members[to]!.id).flatMap(message => parseTaskInputs(message.text) ?? []);
  /** Everything queued so far reached its seat and started its turn. */
  const settle = () => { state = state.map(team => ({ ...team, messages: team.messages.map(message => message.status === 'queued' ? { ...message, status: 'accepted' as const, acceptance: 'started' as const } : message) })); };
  return { broker, as, task, seats, inputs, placed, settle, state: () => state, goOffline: () => { offline = true; } };
}

/** Hosts as the Controllers report them; a folder is allowed when it is listed, and a new one is created once. */
function hostPlaces(hosts: HostPlace[], refuse?: string) {
  const calls: string[] = [], made = new Set<string>();
  const places: HostPlaces = {
    list: async () => hosts, name: id => hosts.find(host => host.id === id)?.name ?? id,
    assertFolder: async (host, _provider, path) => { calls.push(`open ${host} ${path}`); if (!hosts.find(item => item.id === host)?.workspaces?.some(root => path === root.path || root.folders.includes(path))) throw new Error(`Host "${host}" does not open ${path}.`); },
    createFolder: async (host, _provider, name, under) => { calls.push(`create ${host} ${name}`); if (refuse) throw new Error(refuse);
      const path = `${under ?? hosts.find(item => item.id === host)!.workspaces![0]!.path}/${name}`; if (made.has(path)) throw new Error('A file or folder with this name already exists.'); made.add(path); return path; },
  };
  return { places, calls };
}
const studio: HostPlace = { id: 'studio', name: 'Studio', online: true, providers: ['codex'], cpu: { usage: 0.1, cores: 10 }, memory: { used: 20, total: 64 }, sessions: 1,
  workspaces: [{ path: '/Users/x/projects', folders: ['/Users/x/projects/shop'] }] };

describe('bots on another Host', () => {
  it('lists the Hosts of the account to any bot, and to nothing that is no bot', async () => {
    const f = fixture(hostPlaces([studio]).places);
    expect(await f.broker.hostCall('mac', { action: 'list_hosts', owner: f.as('chief') })).toEqual({ hosts: [studio] });
    await expect(f.broker.hostCall('mac', { action: 'list_hosts', owner: f.as('stranger') })).rejects.toThrow();
    await expect(fixture().broker.hostCall('mac', { action: 'list_hosts', owner: f.as('chief') })).rejects.toThrow('not available on this Relay');
  });

  it('starts a sub-session in a folder of another Host, and the item records the Host and the folder', async () => {
    const { places, calls } = hostPlaces([studio]), f = fixture(places);
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Build the shop', brief: 'Build it.' }] });
    const created = await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Builder', prompt: 'Build it.', host: 'studio', cwd: '/Users/x/projects/shop', trackedTaskKeys: [1] });
    expect(created).toMatchObject({ status: 'working', host: 'Studio', folder: '/Users/x/projects/shop' });
    expect(calls).toEqual(['open studio /Users/x/projects/shop']);
    expect(f.task().members.map(member => [member.role, member.hostId])).toEqual([['leader', 'studio'], ['requester', 'mac']]);
    expect(f.task().members[0]!.cwd).toBe('/Users/x/projects/shop');
    expect(f.seats).toEqual([{ hostId: 'mac' }, { hostId: 'studio', cwd: '/Users/x/projects/shop' }]);
    const board = await f.broker.hostCall('mac', { action: 'board', owner: f.as('chief') }) as { items: Array<{ links: unknown[]; assignee: string }> };
    const id = (created as { sub_session_id: string }).sub_session_id;
    expect(board.items[0]).toMatchObject({ assignee: id, links: [{ kind: 'host', value: 'Studio' }, { kind: 'folder', value: '/Users/x/projects/shop' }, { kind: 'sub_session', value: id }] });
  });

  it('creates a new folder once, even when the call is repeated, and answers a refused folder as the outcome with nothing started', async () => {
    const { places, calls } = hostPlaces([studio]), f = fixture(places);
    const input = { action: 'create_sub_session' as const, owner: f.as('chief'), operationId: 'op', name: 'Builder', prompt: 'Build it.', host: 'studio', newFolder: { name: 'shop-api' } };
    const first = await f.broker.hostCall('mac', input) as { sub_session_id: string; folder: string };
    expect(first.folder).toBe('/Users/x/projects/shop-api');
    expect(await f.broker.hostCall('mac', input)).toMatchObject({ sub_session_id: first.sub_session_id, folder: '/Users/x/projects/shop-api' });
    expect(calls.filter(call => call.startsWith('create'))).toEqual(['create studio shop-api']);
    expect(f.state().filter(team => team.task)).toHaveLength(1);
    const refused = fixture(hostPlaces([studio], 'Cannot create a folder here.').places);
    await expect(refused.broker.hostCall('mac', { ...input, owner: refused.as('chief') })).rejects.toThrow('Cannot create a folder here.');
    expect(refused.state().filter(team => team.task)).toHaveLength(0);
  });

  it('starts a standing bot on another Host, whose inbox seat is created there in the folder chosen', async () => {
    const f = fixture(hostPlaces([studio]).places);
    const created = await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Scribe', mission: 'Keep the docs.', host: 'studio', newFolder: { name: 'docs', under: '/Users/x/projects' } });
    expect(created).toMatchObject({ host: 'Studio', folder: '/Users/x/projects/docs' });
    expect(f.seats).toEqual([{ hostId: 'studio', cwd: '/Users/x/projects/docs' }]);
    expect(f.state().find(team => team.inbox?.botId)!.members[0]).toMatchObject({ hostId: 'studio', cwd: '/Users/x/projects/docs' });
  });

  it('refuses a Host without a folder, a folder named twice, a folder the Host does not open and a worktree there', async () => {
    const f = fixture(hostPlaces([studio]).places);
    const call = (extra: Record<string, unknown>) => f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Builder', prompt: 'Build it.', ...extra } as never);
    await expect(call({ host: 'studio' })).rejects.toThrow('Name the folder');
    await expect(call({ host: 'studio', cwd: '/a', newFolder: { name: 'b' } })).rejects.toThrow('not both');
    await expect(call({ host: 'studio', cwd: '/etc' })).rejects.toThrow('does not open /etc');
    await expect(call({ host: 'studio', cwd: '/Users/x/projects/shop', workspace: 'worktree' })).rejects.toThrow('worktree starts from your own commit');
    expect(f.state().filter(team => team.task)).toHaveLength(0);
    // Naming the chief's own Host alone changes nothing.
    expect(await call({ host: 'mac' })).toMatchObject({ status: 'working' });
  });
});

describe('bots calling as their own sessions', () => {
  it('holds a bot\'s acknowledgement back from the Host until another input is queued for the same seat, then sends them together', async () => {
    const f = fixture();
    const polled = async (nativeSessionId: string) => ((await f.broker.hostCall('mac', { action: 'poll' }) as SavedTeam[]).find(team => team.inbox && team.members[0]!.nativeSessionId === nativeSessionId)?.messages ?? [])
      .filter(message => message.status === 'queued').flatMap(message => parseTaskInputs(message.text) ?? []).filter(input => input.kind === 'assistant');
    // The standing instructions went in with the first input and settled.
    await f.broker.hostCall('mac', { action: 'bot_enablement' }); await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'first', to: 'Chief', text: 'Hello.' }); f.settle();
    const send = (operationId: string, text: string, status?: 'ack') => f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId, to: 'Chief', text, ...(status ? { status } : {}) });
    expect(await send('a1', 'Received.', 'ack')).toMatchObject({ outcome: 'delivered' });
    expect(await send('a2', 'Thanks.', 'ack')).toMatchObject({ outcome: 'delivered' });
    // Nothing the Host is given starts a turn: the acknowledgements wait on the Relay.
    expect((await polled('chief')).map(input => 'body' in input ? input.body : '')).toEqual([]);
    const chiefInbox = f.state().find(team => team.inbox?.botId === ids.chief)!;
    expect(chiefInbox.messages.filter(message => message.ack && message.status === 'queued')).toHaveLength(2);
    await send('r1', 'The branch is cut.');
    expect((await polled('chief')).map(input => 'body' in input ? input.body : '')).toEqual(['Received.', 'Thanks.', 'The branch is cut.']);
  });

  it('creates a standing bot in its chief\'s group, with its mission and chief, whose first message waits in its inbox', async () => {
    const f = fixture();
    const created = await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Scribe', mission: 'Keep the release notes.', message: 'Start from v0.3.' }) as { botId: string; status: string };
    expect(created).toMatchObject({ botId: expect.stringMatching(/^b_[0-9a-f]{32}$/), status: 'ready' });
    expect(f.placed).toEqual([{ groupId: 'g', viewId: expect.stringMatching(/^bot-/), details: { botId: created.botId, name: 'Scribe', mission: 'Keep the release notes.', chief: ids.chief } }]);
    const inbox = f.state().find(team => team.inbox?.botId === created.botId)!;
    // Its session was created with its standing instructions, so only its first message waits.
    expect(inbox.inbox).toEqual({ botId: created.botId, instructions: expect.stringMatching(/^[0-9a-f]{64}$/), recent: [expect.objectContaining({ from: ids.chief, hop: 1 })] });
    expect(inbox.members).toEqual([expect.objectContaining({ role: 'leader', creation: 'ready', nativeSessionId: expect.stringMatching(/^worker-/) })]);
    expect(inbox.messages.map(message => parseTaskInputs(message.text)?.[0])).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Chief', body: 'Start from v0.3.' })]);
    expect((await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('chief') }) as { bots: Array<{ name: string }> }).bots.map(bot => bot.name)).toEqual(['Tracker', 'Scribe']);
    // The new bot answers its first message with reply_to.
    const scribe = f.as(inbox.members[0]!.nativeSessionId!), first = inbox.inbox!.recent![0]!.id;
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: scribe, operationId: 'r1', to: 'Chief', text: 'The file exists.', replyTo: first })).toMatchObject({ outcome: 'delivered' });
  });

  it('gives a bot or sub-session created for an item the item\'s brief in its first input', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'update_board', owner: f.as('chief'), items: [{ title: 'Write the script', brief: 'Usage: wordstat FILE; exit 2 on a missing file.' }, { title: 'Write the README', brief: 'Document both scripts.' }] });
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op1', name: 'Scribe', mission: 'Keep the docs.', item: 2 });
    const inbox = f.state().find(team => team.inbox?.botId && team.members[0]!.name === 'Scribe')!;
    expect(inbox.messages.map(message => parseTaskInputs(message.text)?.[0])).toEqual([expect.objectContaining({ kind: 'assistant', body: expect.stringContaining('Document both scripts.') })]);
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op2', name: 'Coder', prompt: 'Code it.', trackedTaskKeys: [1] });
    expect(parseTaskInputs(f.task().messages[0]!.text)?.[0]).toMatchObject({ kind: 'brief', brief: expect.stringContaining('Usage: wordstat FILE; exit 2 on a missing file.') });
  });

  it('lets a standing bot record a lasting change to its own mission, without sending it its instructions again', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'hi', to: 'Chief', text: 'Hello.' });
    const before = f.state().find(team => team.inbox?.botId === ids.chief)!.messages.length;
    expect(await f.broker.hostCall('mac', { action: 'update_mission', owner: f.as('chief'), mission: 'Lead the release; review every change first.' })).toEqual({ mission: 'Lead the release; review every change first.' });
    expect((await f.broker.hostCall('mac', { action: 'list_bots', owner: f.as('tracker') }) as { bots: Array<{ name: string; mission?: string }> }).bots).toEqual([expect.objectContaining({ name: 'Chief', mission: 'Lead the release; review every change first.' })]);
    // Its inbox counts the new standing instructions as sent, so the next poll queues nothing.
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.inbox!.instructions).toBe(instructionsHash('Lead the release; review every change first.'));
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.messages).toHaveLength(before);
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', prompt: 'Review it.' });
    await expect(f.broker.hostCall('mac', { action: 'update_mission', owner: f.as(f.task().members[0]!.nativeSessionId!), mission: 'Something else.' })).rejects.toThrow('not a bot');
  });
  it('answers every message with one of the five outcomes, each of them a valid result of the protocol', async () => {
    const f = fixture();
    const send = (owner: ReturnType<typeof f.as>, to: string, operationId: string, extra: Record<string, unknown> = {}) =>
      f.broker.hostCall('mac', { action: 'bot_message', owner, operationId, to, text: 'Hello.', ...extra } as never) as Promise<{ outcome: string }>;
    const results = [
      await send(f.as('chief'), 'Tracker', 'o1'),
      await send(f.as('chief'), 'Tracker', 'o1'),
      await send(f.as('chief'), 'Nobody', 'o2'),
      await send(f.as('chief'), 'Chief', 'o3'),
    ];
    expect(results.map(result => result.outcome)).toEqual(['delivered', 'duplicate', 'unreachable', 'forbidden']);
    // A sub-session is no bot: another bot's message to its name or its id is unreachable, and it messages no one.
    const sub = await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op', name: 'Reviewer', prompt: 'Review it.' }) as { sub_session_id: string };
    const worker = f.as(f.task().members[0]!.nativeSessionId!);
    results.push(await send(f.as('tracker'), 'Reviewer', 't1'), await send(f.as('tracker'), sub.sub_session_id, 't2'), await send(worker, 'chief', 'p1', { status: 'progress' }));
    expect(results.slice(4).map(result => result.outcome)).toEqual(['unreachable', 'unreachable', 'forbidden']);
    // What the sender is told is what the fixtures of the protocol allow.
    const fixtures = JSON.parse(readFileSync(new URL('../../agent-remote-protocol/src/fixtures/bot-messages.v1.json', import.meta.url), 'utf8'));
    expect(fixtures.results.valid.every(isBotMessageResult)).toBe(true);
    expect(results.every(isBotMessageResult)).toBe(true);
  });

  it('holds a message for a bot whose session is not ready, and tells the sender so', async () => {
    const f = fixture();
    f.goOffline();
    expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'o2', to: 'Tracker', text: 'Again.' })).toMatchObject({ outcome: 'held' });
  });

  it('tells a bot\'s chief what the person wrote to the bot, once, and nobody when the person is its chief', async () => {
    const f = fixture();
    await f.broker.hostCall('mac', { action: 'create_bot', owner: f.as('chief'), operationId: 'op', name: 'Scribe', mission: 'Keep the release notes.' });
    const scribe = f.as(f.state().find(team => team.inbox?.pending === undefined && team.members[0]!.nativeSessionId?.startsWith('worker-'))!.members[0]!.nativeSessionId!);
    const wrote = { action: 'bot_told' as const, owner: scribe, text: 'Skip   the\nflaky test.', cause: { kind: 'person' as const, messageId: 'u1' } };
    expect(await f.broker.hostCall('mac', wrote)).toMatchObject({ outcome: 'delivered' });
    const chief = f.state().find(team => team.inbox?.botId === ids.chief)!;
    expect(parseTaskInputs(chief.messages.at(-1)!.text)).toEqual([{ kind: 'person_wrote', bot: 'Scribe', body: 'Skip the flaky test.' }]);
    expect(await f.broker.hostCall('mac', wrote)).toMatchObject({ outcome: 'duplicate' });
    expect(f.state().find(team => team.inbox?.botId === ids.chief)!.messages).toHaveLength(chief.messages.length);
    // Its chief is the person, or it is a sub-session, which is no bot and whose own report tells its bot what the person wrote.
    expect(await f.broker.hostCall('mac', { ...wrote, owner: f.as('tracker') })).toMatchObject({ outcome: 'unreachable' });
    await f.broker.hostCall('mac', { action: 'create_sub_session', owner: f.as('chief'), operationId: 'op2', name: 'Reviewer', prompt: 'Review it.' });
    expect(await f.broker.hostCall('mac', { ...wrote, owner: f.as(f.task().members[0]!.nativeSessionId!) })).toMatchObject({ outcome: 'forbidden' });
  });

  describe('attachments', () => {
    const bytes = Buffer.from('--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-draft\n+final\n');
    const upload = async (f: ReturnType<typeof fixture>, owner: ReturnType<typeof f.as>, name = 'notes.patch') => {
      const begun = await f.broker.hostCall('mac', { action: 'attachment_begin', owner, name, mediaType: 'text/x-diff', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }) as { id: string };
      await f.broker.hostCall('mac', { action: 'attachment_chunk', owner, attachment: begun.id, offset: 0, contentBase64: bytes.toString('base64') });
      return await f.broker.hostCall('mac', { action: 'attachment_finish', owner, attachment: begun.id }) as { id: string; sha256: string };
    };

    it('lists the files a message carries after its words, and lets the receiver read them back whole', async () => {
      const f = fixture(), file = await upload(f, f.as('chief'));
      expect(await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Tracker', text: 'The notes patch.', attachments: [file.id] })).toMatchObject({ outcome: 'delivered' });
      const tracker = f.state().find(team => team.inbox?.botId === ids.tracker)!, [input] = parseTaskInputs(tracker.messages.at(-1)!.text)!;
      expect((input as { body: string }).body).toBe(`The notes patch.\n${attachmentLines([{ id: file.id, name: 'notes.patch', mediaType: 'text/x-diff', byteLength: bytes.length, sha256: file.sha256 }])}`);
      const read = await f.broker.hostCall('mac', { action: 'attachment_read', owner: f.as('tracker'), attachment: file.id, offset: 0 }) as { attachment: { byteLength: number }; contentBase64: string };
      expect(Buffer.from(read.contentBase64, 'base64')).toEqual(bytes);
      expect(read.attachment.byteLength).toBe(bytes.length);
    });

  });

  describe('replies from the final text of a turn', () => {
    const inboxOf = (f: ReturnType<typeof fixture>, botId: string) => f.state().find(team => team.inbox?.botId === botId)!;
    const received = async (f: ReturnType<typeof fixture>, text = 'Is the branch cut?') => {
      await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('tracker'), operationId: 'q1', to: 'Chief', text });
      return inboxOf(f, ids.chief).inbox!.recent!.at(-1)!.id;
    };

    it('sends the text back to the sender as a reply that names the message, once', async () => {
      const f = fixture();
      const asked = await received(f);
      const reply = { action: 'bot_reply' as const, owner: f.as('chief'), text: 'Yes, cut at noon.', cause: { kind: 'framed' as const, answers: asked } };
      expect(await f.broker.hostCall('mac', reply)).toMatchObject({ outcome: 'delivered', messageId: expect.stringMatching(/^m[0-9a-f]{12}$/) });
      const tracker = inboxOf(f, ids.tracker);
      expect(parseTaskInputs(tracker.messages.at(-1)!.text)).toEqual([expect.objectContaining({ kind: 'assistant', from: 'Chief', replyTo: asked, body: 'Yes, cut at noon.' })]);
      expect(await f.broker.hostCall('mac', reply)).toMatchObject({ outcome: 'duplicate' });
      expect(inboxOf(f, ids.tracker).messages).toHaveLength(tracker.messages.length);
    });

    it('cuts a final text at 300 characters with a pointer to the rest', async () => {
      const f = fixture();
      const asked = await received(f);
      await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('chief'), text: 'x'.repeat(2000), cause: { kind: 'framed', answers: asked } });
      const [input] = parseTaskInputs(inboxOf(f, ids.tracker).messages.at(-1)!.text)!;
      const body = (input as { body: string }).body;
      expect(body).toHaveLength(300);
      expect(body).toMatch(/^x+ … \[cut; read the rest of Chief's answer with read_bot\]$/);
    });

    it('sends nothing when the turn already answered its sender with message, to whom it was said or by reply_to', async () => {
      const f = fixture();
      const asked = await received(f);
      const turn = { kind: 'framed' as const, answers: asked };
      await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'a1', to: 'Tracker', text: 'Working on it.', cause: turn });
      const before = inboxOf(f, ids.tracker).messages.length;
      expect(await f.broker.hostCall('mac', { action: 'bot_reply', owner: f.as('chief'), text: 'Done.', cause: turn })).toMatchObject({ outcome: 'duplicate' });
      expect(inboxOf(f, ids.tracker).messages).toHaveLength(before);
      // A message to another bot in that turn does not count as answering the sender.
      const f2 = fixture();
      const asked2 = await received(f2);
      await f2.broker.hostCall('mac', { action: 'create_bot', owner: f2.as('chief'), operationId: 'op', name: 'Reviewer', mission: 'Review it.', lifetime: 'temporary' });
      await f2.broker.hostCall('mac', { action: 'bot_message', owner: f2.as('chief'), operationId: 'a2', to: 'Reviewer', text: 'Look.', cause: { kind: 'framed', answers: asked2 } });
      expect(await f2.broker.hostCall('mac', { action: 'bot_reply', owner: f2.as('chief'), text: 'Asked the reviewer.', cause: { kind: 'framed', answers: asked2 } })).toMatchObject({ outcome: 'delivered' });
    });

  });
});

describe('a session that a plain window also shows', () => {
  // Opening a session in a page gives it a window of its own, with no bot details, ahead of the group that makes it a bot.
  const plainWindow = (nativeSessionId: string) => ({ window: { id: 'plain-' + nativeSessionId, title: nativeSessionId, revision: 1, views: [{ id: 'main', placement: 'primary',
    binding: { hostId: 'mac', providerId: 'codex', nativeSessionId, title: nativeSessionId } }] } }) as unknown as WindowGroup;

  it('speaks as the bot, so a message to another bot is recorded as received from a bot id', async () => {
    const f = fixture(undefined, [plainWindow('chief')]);
    await f.broker.hostCall('mac', { action: 'bot_message', owner: f.as('chief'), operationId: 'm1', to: 'Tracker', text: 'The notes are ready.' });
    const inbox = f.state().find(team => team.inbox)!;
    expect(inbox.inbox!.recent).toEqual([expect.objectContaining({ from: ids.chief })]);
    expect(inbox.messages.at(-1)!.text).toContain('from Chief');
  });
});
