// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { createReplicaState, timelineEntryKey, type AgentReplicaState, type ProcessMode } from '@orchardworks/agent-client';
import { SESSION_CONNECTION_PATTERN, TimelineRows, TURN_VECTORS } from '@orchardworks/agent-client/testing';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { LocaleContext } from './locale.js';
import { MotionProvider, useMotionState } from '../primitives/MotionProvider.js';

/** Two ended turns of work and answers, and a running third, as a replica holds them. */
function conversation(running = false): AgentReplicaState {
  const rows = new TimelineRows('claude', Date.parse('2026-11-20T10:00:00Z'));
  rows.user('Write notes.md', { key: 'p1', turnId: 't1' });
  rows.tool('Read', { type: 'read', filePath: '/w/README.md' }, 'completed', { key: 'read-1', turnId: 't1' });
  rows.tool('Write', { type: 'write', filePath: '/w/notes.md' }, 'completed', { key: 'write-1', turnId: 't1' });
  rows.assistant('Wrote it.', { key: 'a1', turnId: 't1' });
  rows.assistant('Anything else?', { key: 'a1b', turnId: 't1' });
  rows.user('Run the tests', { key: 'p2', turnId: 't2' });
  rows.tool('Bash', { type: 'shell', command: 'npm test' }, running ? 'running' : 'completed', { key: 'test-2', turnId: 't2',
    ...(running ? {} : { result: { content: [{ type: 'text' as const, text: 'all green' }], exitCode: 0 } }) });
  if (!running) rows.assistant('All green.', { key: 'a2', turnId: 't2' });
  const base = createReplicaState();
  return { ...base, agent: { id: 'agent', providerId: 'claude', createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:00:00Z',
    status: running ? 'running' : 'idle', activeTurn: running ? { turnId: 't2', startedAt: '2026-11-20T10:00:06Z' } : null, pendingInteractions: [],
    capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
    runtimeInfo: { providerId: 'claude', sessionId: 'native', status: running ? 'running' : 'idle' } },
  timeline: { ...base.timeline, epoch: 'e', initialized: true, entries: rows.entries, nextSeq: rows.entries.length + 1 } };
}

const lines = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('.agent-work-line > button')];
const expanded = (container: HTMLElement) => lines(container).map(button => button.getAttribute('aria-expanded'));
const shownKeys = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => node.dataset.entryKey);

describe('the timeline renders turns', () => {
  it.each([
    ['concise', false, ['false', 'false'], 'summary'],
    ['concise', true, ['false', 'false'], 'summary'],
    ['process', false, ['false', 'false'], 'summary'],
    ['process', true, ['false', 'true'], 'summary'],
    ['full', false, ['true', 'true'], 'preview'],
    ['full', true, ['true', 'true'], 'preview'],
  ] as const)('%s with the last turn running %s: the work lines are %j and open steps show at %s level', async (mode, running, open, level) => {
    const container = await render(<AgentTimeline state={conversation(running)} processMode={mode} />);
    expect(expanded(container)).toEqual(open);
    for (const steps of container.querySelectorAll<HTMLElement>('.agent-work-steps')) expect(steps.dataset.stepLevel).toBe(level);
    expect(container.querySelectorAll('.agent-tool-preview').length > 0).toBe(level === 'preview');
  });

  it('opens one turn at a reader\'s toggle, leaves the others, and resets every choice when the mode changes', async () => {
    const container = await render(<AgentTimeline state={conversation()} processMode="concise" />);
    await act(async () => lines(container)[0]!.click());
    expect(expanded(container)).toEqual(['true', 'false']);
    expect(container.querySelector('[data-step-level]')?.getAttribute('data-step-level')).toBe('summary');
    expect(shownKeys(container)).toContain('read-1');
    await rerender(container, <AgentTimeline state={conversation()} processMode="full" />);
    expect(expanded(container)).toEqual(['true', 'true']);
    await act(async () => lines(container)[1]!.click());
    expect(expanded(container)).toEqual(['true', 'false']);
    await rerender(container, <AgentTimeline state={conversation()} processMode="concise" />);
    expect(expanded(container)).toEqual(['false', 'false']);
  });

  it('opens the turn a search hit is in, at preview level, and the reader can close it again', async () => {
    const state = conversation();
    const target = state.timeline.entries.find(entry => entry.itemKey === 'write-1')!;
    const container = await render(<AgentTimeline state={state} processMode="concise" searchEntryKey={timelineEntryKey(target)} searchRequestId={1} />);
    expect(expanded(container)).toEqual(['true', 'false']);
    expect(container.querySelector('.agent-work-steps')?.getAttribute('data-step-level')).toBe('preview');
    expect(container.querySelector('[data-search-selected]')?.getAttribute('data-entry-key')).toBe('write-1');
    await act(async () => lines(container)[0]!.click());
    expect(expanded(container)).toEqual(['false', 'false']);
  });

  it('closes the turn a search opened once the search ends', async () => {
    const state = conversation();
    const target = timelineEntryKey(state.timeline.entries.find(entry => entry.itemKey === 'write-1')!);
    const view = (key?: string) => <AgentTimeline state={state} processMode="concise" searchEntryKey={key} searchRequestId={key ? 1 : undefined} />;
    const container = await render(view(target));
    expect(expanded(container)).toEqual(['true', 'false']);
    await rerender(container, view(undefined));
    expect(expanded(container)).toEqual(['false', 'false']);
  });

  it('shows the prompt as the person\'s bubble and the answer as the assistant\'s, the avatar at the foot of the last', async () => {
    const container = await render(<AgentTimeline state={conversation()} processMode="concise" assistant={{ name: 'Chief', avatar: <span data-testid="avatar" /> }} />);
    const rows = [...container.querySelectorAll<HTMLElement>('.orchard-bubble-row')];
    expect(rows.map(row => row.dataset.from)).toEqual(['mine', 'theirs', 'theirs', 'mine', 'theirs']);
    expect(rows.map(row => !!row.querySelector('[data-testid="avatar"]'))).toEqual([false, false, true, false, true]);
    expect(rows[1]!.querySelector('.agent-bubble-avatar-space')).not.toBeNull();
    expect(container.querySelectorAll('.orchard-bubble .agent-item-kicker')).toHaveLength(0);
    expect(lines(container).map(line => line.textContent)).toEqual(['Read README.md, wrote notes.md', 'Ran a command']);
  });

  it('moves only the latest answer\'s avatar, so a long conversation does not move dozens of them', async () => {
    const Probe = () => <span data-testid="avatar" data-still={String(useMotionState().reducedMotion)} />;
    const port = { read: () => ({ reducedMotion: false, pageVisible: true }), subscribe: () => () => {} };
    const container = await render(<MotionProvider port={port}><AgentTimeline state={conversation()} processMode="concise" assistant={{ name: 'Chief', avatar: <Probe /> }} /></MotionProvider>);
    expect([...container.querySelectorAll('[data-testid="avatar"]')].map(node => node.getAttribute('data-still'))).toEqual(['true', 'false']);
  });

  it('places a request waiting for the person in its turn, after the answer, as an inline card', async () => {
    const state = conversation(true);
    const request = { kind: 'tool_approval' as const, requestId: 'write', toolCallId: 'call', toolName: 'Write', summary: 'Allow Write?',
      detail: { type: 'write' as const, filePath: '/w/notes.md' }, allowedDecisions: ['allow' as const, 'deny' as const], allowScopes: ['once' as const] };
    const container = await render(<AgentTimeline state={{ ...state, pendingInteractions: [request] }} assistant={{ name: 'Chief' }} onInteractionResponse={async () => {}} />);
    const turns = [...container.querySelectorAll('.agent-turn')];
    const card = turns.at(-1)!.querySelector('.agent-tool-approval')!;
    expect(card.querySelector('.orchard-approval-prompt')?.textContent).toBe('Chief wants to write notes.md');
    expect(turns[0]!.querySelector('.agent-tool-approval')).toBeNull();
    expect(container.querySelector('aside')).toBeNull();
    const last = [...turns.at(-1)!.querySelectorAll('.agent-timeline-entry, .agent-tool-approval')].at(-1);
    expect(last).toBe(card);
  });

  it('shows "Assistant" and no avatar when the host names no assistant', async () => {
    const container = await render(<AgentTimeline state={conversation()} />);
    // Each answer bubble keeps the avatar's room, so the answers line up as they would with one.
    expect(container.querySelectorAll('.orchard-bubble-avatar .agent-bubble-avatar-space')).toHaveLength(3);
  });

  it('says the work line in the reader\'s language', async () => {
    const container = await render(<LocaleContext.Provider value="zh"><AgentTimeline state={conversation()} /></LocaleContext.Provider>);
    expect(lines(container).map(line => line.textContent)).toEqual(['翻了 README.md，写好了 notes.md', '跑了 1 条命令']);
  });

  it('draws a day line before the first turn and after half an hour, not between close turns', async () => {
    const state = conversation();
    const later = state.timeline.entries.map((entry, index): ProjectedTimelineEntry => index >= 5 ? { ...entry, timestamp: new Date(Date.parse(entry.timestamp) + 45 * 60_000).toISOString() } : entry);
    const container = await render(<AgentTimeline state={state} />);
    expect(container.querySelectorAll('.agent-day-separator')).toHaveLength(1);
    await rerender(container, <AgentTimeline state={{ ...state, timeline: { ...state.timeline, entries: later } }} />);
    expect(container.querySelectorAll('.agent-day-separator')).toHaveLength(2);
    expect(container.querySelector('.agent-day-separator')?.getAttribute('role')).toBe('separator');
  });

  it('keeps every entry of every vector row reachable: in Full each one is a row of the timeline', async () => {
    for (const vector of TURN_VECTORS) {
      const base = createReplicaState();
      const container = await render(<AgentTimeline processMode="full" state={{ ...base, timeline: { ...base.timeline, epoch: 'e', initialized: true, entries: [...vector.entries] } }} />);
      for (const button of container.querySelectorAll<HTMLButtonElement>('.agent-background-summary[aria-expanded="false"], .agent-notice-toggle[aria-expanded="false"]')) await act(async () => button.click());
      expect(new Set(shownKeys(container)), vector.name).toEqual(new Set(vector.entries.map(timelineEntryKey)));
    }
  });
});

describe('the live line', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('shows only while the last turn runs, says the running step, the todo progress and the time since the turn started', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-20T10:01:16Z'), toFake: ['Date', 'setInterval', 'clearInterval'] });
    const running = conversation(true);
    const rows = new TimelineRows('claude', Date.parse('2026-11-20T10:00:00Z'));
    rows.todo([{ text: 'Write', completed: true, status: 'completed' }, { text: 'Test', completed: false, status: 'in_progress' }], { key: 'todo-2', turnId: 't2' });
    const state = { ...running, timeline: { ...running.timeline, entries: [...running.timeline.entries.slice(0, -1), { ...rows.entries[0]!, seqStart: 90, seqEnd: 90 }, running.timeline.entries.at(-1)!] } };
    const container = await render(<AgentTimeline state={state} assistant={{ name: 'Chief', avatar: <span data-testid="avatar" /> }} />);
    const line = container.querySelector<HTMLElement>('.agent-turn-status')!;
    expect(line.closest('.agent-turn')).toBe([...container.querySelectorAll('.agent-turn')].at(-1));
    expect(line.querySelector('[role="status"]')?.textContent).toBe('Chief is running tests');
    expect(line.querySelector('.orchard-status-detail')?.textContent).toBe('working · 1m 10s · 1 of 2 done');
    expect(line.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(container.textContent).not.toMatch(SESSION_CONNECTION_PATTERN);
    await rerender(container, <AgentTimeline state={conversation(false)} assistant={{ name: 'Chief' }} />);
    expect(container.querySelector('.agent-turn-status')).toBeNull();
  });

  it('says the assistant is working when its turn is not loaded yet, and gives way to a request waiting for the person', async () => {
    const ended = conversation(false);
    const working = { ...ended, agent: { ...ended.agent!, status: 'running' as const, activeTurn: { turnId: 't9', startedAt: null } } };
    const container = await render(<LocaleContext.Provider value="zh"><AgentTimeline state={working} assistant={{ name: 'Chief' }} /></LocaleContext.Provider>);
    const line = container.querySelector('.agent-turn-status')!;
    expect(line.closest('.agent-turn')).toBeNull();
    expect(line.querySelector('[role="status"]')?.textContent).toBe('Chief 在忙');
    expect(line.querySelector('.orchard-status-detail')?.textContent).toBe('认真工作中');
    const request = { kind: 'question' as const, requestId: 'q', questions: [{ questionId: 'a', header: 'A', prompt: 'Which?', required: true, selection: 'single' as const, options: [], allowCustomText: true, allowDismiss: false }] };
    await rerender(container, <AgentTimeline state={{ ...working, pendingInteractions: [request] }} assistant={{ name: 'Chief' }} />);
    expect(container.querySelector('.agent-turn-status')).toBeNull();
  });
});

it('keeps the turn modes typed: every process mode renders', async () => {
  for (const mode of ['concise', 'process', 'full'] satisfies ProcessMode[]) {
    const container = await render(<AgentTimeline state={conversation()} processMode={mode} />);
    expect(container.querySelector('.agent-timeline-entries')?.getAttribute('data-process-mode')).toBe(mode);
  }
});
