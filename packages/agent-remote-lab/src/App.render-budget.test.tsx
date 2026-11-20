import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import * as rosterModel from './bot-roster.js';
import * as botWorkspaceHooks from './hooks/useBotWorkspace.js';
import * as conversation from './components/SessionConversation.js';
import { botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';

// Stage 6's render budgets: the work of a change is the work of the conversations it concerns (see the stage 6 plan).
const GROUPS = 12, BOTS = 10;
function largeGroup(index: number): WindowGroup {
  const id = `G${index}`;
  const views = Array.from({ length: BOTS }, (_, bot) => createWindowView(`${id}v${bot}`, botTarget(`${id}s${bot}`), 'primary'));
  return { window: { schemaVersion: 3, id, revision: 0, title: id, selectedPrimaryViewId: views[0]!.id, selectedViewId: views[0]!.id, views },
    bots: { rank: `r${String(index).padStart(3, '0')}`, members: {} } };
}
const session = (nativeSessionId: string) => ({ hostId: 'local', providerId: 'recorded', nativeSessionId });

async function largeWorkbench(name: string) {
  const scope = `http://localhost/u/${name}/`;
  for (let index = 0; index < GROUPS; index++) seedGroup(scope, largeGroup(index));
  history.replaceState(null, '', '/?window=G0');
  const renders = vi.spyOn(conversation, 'SessionConversation');
  const projections = vi.spyOn(rosterModel, 'projectBotRoster');
  // App calls this once per render.
  const appRenders = vi.spyOn(botWorkspaceHooks, 'useBotWorkspace');
  const app = await mountBotApp(scope, { hosted: true });
  const rows = () => [...app.container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Assistants"] .lab-bot-row')];
  const open = async (bot: string) => {
    await act(async () => app.button(bot).click());
    // Not the fixture's three seconds: before stage 6 a switch took longer than that here.
    await vi.waitFor(async () => { await act(async () => {}); expect(app.container.querySelector('.lab-bot-row[aria-current="true"]')?.getAttribute('aria-label')).toBe(bot); }, { timeout: 20_000, interval: 5 });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  };
  /** Renders of each session's conversation, and roster projections, while change runs. */
  const count = async (change: () => void | Promise<void>) => {
    renders.mockClear(); projections.mockClear(); appRenders.mockClear();
    // Not inside act: a change that waits for the page (open) flushes its own updates.
    await change();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const bySession: Record<string, number> = {};
    for (const [props] of renders.mock.calls) { const id = props.target.nativeSessionId; bySession[id] = (bySession[id] ?? 0) + 1; }
    return { bySession, projections: projections.mock.calls.length, appRenders: appRenders.mock.calls.length };
  };
  await app.switchMode('bot');
  await until(() => expect(rows().length).toBeGreaterThanOrEqual(GROUPS * BOTS));
  return { app, open, count };
}
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('a change of a bot elsewhere renders its roster row, not App and not a conversation', { timeout: 60_000 }, async () => {
  const { app, open, count } = await largeWorkbench('render-budget-frames');
  await open('G0s0');
  const changes: Array<[string, () => void]> = [
    ['state', () => app.emitStates({ hosts: [{ hostId: 'local', online: true }], states: [{ ...session('G5s1'), state: 'running', ageMs: 0 }] })],
    ['reply', () => app.emitStates({ states: [{ ...session('G6s1'), state: 'idle', ageMs: 0, replyAt: 2000, preview: 'Reply' }] })],
    ['read', () => app.emitReads({ reads: [{ ...session('G6s1'), readAt: 2000 }] })],
    ['draft', () => app.emitDrafts({ drafts: [{ ...session('G7s1'), text: 'Draft', revision: 10 }] })],
    ['outbox', () => app.emitOutbox({ entries: [{ id: '00000000-0000-4000-8000-000000000001', ...session('G8s1'), text: 'Later', createdAt: 1000, status: 'waiting' }] })],
  ];
  for (const [label, change] of changes) {
    const { bySession, projections, appRenders } = await count(() => act(async () => change()));
    // Shared IM state is read where it is shown: the roster, and the conversation's own outbox bubbles.
    expect({ label, conversations: bySession }).toEqual({ label, conversations: {} });
    expect({ label, appRenders }).toEqual({ label, appRenders: 0 });
    expect({ label, projections }).toEqual({ label, projections: 1 });
  }
  await app.close();
});

it('switching bots renders the conversations that change and leaves the others alone', { timeout: 60_000 }, async () => {
  const { app, open, count } = await largeWorkbench('render-budget-switch');
  await open('G0s0');
  let previous = 'G0s0';
  for (const bot of ['G3s2', 'G4s5', 'G3s2']) {
    const { bySession } = await count(() => open(bot));
    const others = Object.keys(bySession).filter(id => id !== bot && id !== previous);
    expect({ bot, others }).toEqual({ bot, others: [] });
    // The conversation left hides once; the one opened renders as it opens and settles.
    expect(bySession[previous] ?? 0).toBeLessThanOrEqual(2);
    previous = bot;
  }
  await app.close();
});

it('in Window mode a change in one pane renders the visible panes at most once and no hidden conversation', { timeout: 60_000 }, async () => {
  const { app, open, count } = await largeWorkbench('render-budget-window');
  await open('G3s2');
  await app.switchMode('window');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
  const { bySession } = await count(() => act(async () => app.emitStatus('agent-G0s2', 'running')));
  // The bot conversation left in Bot mode is hidden in Window mode.
  expect(bySession.G3s2 ?? 0).toBe(0);
  for (const [id, renders] of Object.entries(bySession)) if (id !== 'G0s2') expect({ id, renders }).toEqual({ id, renders: 1 });
  await app.close();
});
