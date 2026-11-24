import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { render, unmount } from '../test/setup.js';

const fixture = vi.hoisted(() => ({ lists: 0, teams: [] as unknown[], failure: '' }));
vi.mock('@orchardworks/agent-client', async importOriginal => ({ ...await importOriginal<typeof import('@orchardworks/agent-client')>(),
  RemoteTeamClient: class { async list() { fixture.lists++; if (fixture.failure) throw new Error(fixture.failure); return structuredClone(fixture.teams); } } }));
import { useTeamRoster, useWatchTeamRoster } from './useTeamRoster.js';

const member = { hostId: 'mac', providerId: 'fixture', responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 };
const base = { operationId: 'op', revision: 1, source: { hostId: 'mac', providerId: 'fixture', nativeSessionId: 'main', title: 'Main' }, status: 'active' as const, messages: [], createdAt: 1, updatedAt: 1 };
const room = (state: 'open' | 'done'): Team => ({ ...base, id: 'room', title: 'Room', members: [{ ...member, id: 'a', role: 'requester', name: 'A', nativeSessionId: 'a' }, { ...member, id: 'b', role: 'requester', name: 'B', nativeSessionId: 'b' }],
  room: { name: 'Launch', topic: 'Plan', state, deadline: 1, turns: 0, seen: {}, passed: [], transcript: [] } });
const inbox: Team = { ...base, id: 'inbox', title: 'Bot', members: [{ ...member, id: 'bot', role: 'requester', name: 'Bot', nativeSessionId: 'bot' }], inbox: { botId: `b_${'0'.repeat(32)}` } };

const answers: Team = { ...base, id: 'answers', title: 'Answers', members: [{ ...member, id: 'ans', role: 'leader', name: 'Bot', nativeSessionId: 'answer-1' }],
  ask: { botId: `b_${'1'.repeat(32)}`, from: { hostId: 'mac', providerId: 'fixture', nativeSessionId: 'main', name: 'Main' }, lastAt: 1, entries: [{ id: 'e', text: 'Q?', at: 1 }] } };

let published: { teams: Team[]; tasks: Team[] } | undefined;
function Harness() {
  const [roster, setRoster] = useState<{ baseUrl: string; teams: Team[]; tasks: Team[] }>();
  const { loadError } = useTeamRoster({ baseUrl: 'https://relay.test', enabled: true, teams: roster?.teams, tasks: roster?.tasks,
    publish: (baseUrl, teams, tasks) => { setRoster({ baseUrl, teams, tasks }); published = { teams, tasks }; } });
  return <p role="status">{loadError}</p>;
}
afterEach(() => { fixture.lists = 0; fixture.teams = []; fixture.failure = ''; published = undefined; vi.useRealTimers(); });

it('reads the roster and splits what the page shows in Chats from the tasks and bot inboxes boards come from', async () => {
  fixture.teams = [room('open'), inbox];
  const view = await render(<Harness />);
  await vi.waitFor(() => expect(published).toBeDefined());
  expect(published!.teams.map(team => team.id)).toEqual(['room']);
  expect(published!.tasks.map(team => team.id)).toEqual(['inbox']);
  await unmount(view);
});

it('keeps answer sessions with the tasks, never among the rooms', async () => {
  fixture.teams = [room('open'), answers];
  const view = await render(<Harness />);
  await vi.waitFor(() => expect(published).toBeDefined());
  expect(published!.teams.map(team => team.id)).toEqual(['room']);
  expect(published!.tasks.map(team => team.id)).toEqual(['answers']);
  await unmount(view);
});

it('refreshes every 4 s while a room is open, and twice a minute otherwise', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fixture.teams = [room('done')];
  const view = await render(<Harness />);
  const minute = async () => { fixture.lists = 0; await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); return fixture.lists; };
  expect(await minute()).toBe(2);
  fixture.teams = [room('open')];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(await minute()).toBe(15);
  fixture.teams = [room('done')];
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(await minute()).toBe(2);
  await unmount(view);
});

it('refreshes every 4 s while a question asked of a bot has no answer, and twice a minute once it has one', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fixture.teams = [answers];
  const view = await render(<Harness />);
  const minute = async () => { fixture.lists = 0; await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); return fixture.lists; };
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(await minute()).toBe(15);
  fixture.teams = [{ ...answers, ask: { ...answers.ask!, entries: [{ ...answers.ask!.entries[0]!, answer: { text: 'A.', at: 2 } }] } }];
  await act(async () => { await vi.advanceTimersByTimeAsync(4_000); });
  expect(await minute()).toBe(2);
  await unmount(view);
});

it('says when the Relay cannot be read and clears it with the next read', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fixture.failure = 'Relay unavailable';
  const view = await render(<Harness />);
  await vi.waitFor(() => expect(view.textContent).toContain('Relay unavailable'));
  fixture.failure = ''; fixture.teams = [room('done')];
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(view.textContent).not.toContain('Relay unavailable');
  await unmount(view);
});

it('refreshes every 4 s while a bot\'s board is shown in its details, and twice a minute once it closes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  fixture.teams = [room('done')];
  let show: (shown: boolean) => void = () => {};
  function BoardView() { const [shown, setShown] = useState(false); show = setShown; useWatchTeamRoster(shown); return null; }
  const view = await render(<><Harness /><BoardView /></>);
  const minute = async () => { fixture.lists = 0; await act(async () => { await vi.advanceTimersByTimeAsync(60_000); }); return fixture.lists; };
  expect(await minute()).toBe(2);
  await act(async () => show(true));
  expect(await minute()).toBe(15);
  await act(async () => show(false));
  expect(await minute()).toBe(2);
  await unmount(view);
});
