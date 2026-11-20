// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { HistoryPage, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { render, rerender } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { applyHistoryPage, applyTimelineReplacement, createReplicaState } from '@orchardworks/agent-client';

const renders = vi.hoisted(() => vi.fn());
// Each turn works out its work line once per render, so the calls count the turns rendered.
const turnRenders = vi.hoisted(() => vi.fn());
vi.mock('@orchardworks/agent-client', async original => {
  const module = await original<typeof import('@orchardworks/agent-client')>();
  return { ...module, workSummary: (...args: Parameters<typeof module.workSummary>) => { turnRenders(); return module.workSummary(...args); } };
});
vi.mock('./TimelineEntry.js', async original => {
  const module = await original<typeof import('./TimelineEntry.js')>();
  return { ...module, TimelineEntry: (props: Parameters<typeof module.TimelineEntry>[0]) => {
    renders(props.entryKey);
    return <module.TimelineEntry {...props} />;
  } };
});

const row = (key: string, seq: number, text: string): ProjectedTimelineEntry => ({
  providerId: 'copilot', itemKey: key, turnId: 'turn', timestamp: '2026-11-16T00:00:00Z', seqStart: seq, seqEnd: seq,
  sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [],
  item: { type: 'assistant_message', messageId: key, text },
});
const userRow = (key: string, seq: number, text: string): ProjectedTimelineEntry => ({ ...row(key, seq, text), item: { type: 'user_message', messageId: key, text } });
const tail = (epoch: string, entries: ProjectedTimelineEntry[]): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
  requestId: 'r', agentId: 'agent', direction: 'tail', epoch, reset: false, staleCursor: false, gap: false,
  window: { minSeq: 1, maxSeq: entries.length, nextSeq: entries.length + 1 }, startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: entries.length },
  hasOlder: false, hasNewer: false, entries, error: null } });
const initial = (entries: ProjectedTimelineEntry[]) => applyHistoryPage(createReplicaState(), tail('epoch-one', entries)).state;

describe('a replacement that carries rows over', () => {
  it('renders only the changed and the new rows, keeps the other row nodes and the timeline container, and repeats no key', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = initial(Array.from({ length: 12 }, (_, index) => row(`k${index}`, index + 1, `Reply ${index}`)));
    const container = await render(<AgentTimeline state={before} />);
    const entries = container.querySelector('.agent-timeline-entries');
    const nodes = new Map([...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey, node]));
    renders.mockClear();

    // k3 changes, k5 is gone, n1 is new, and every sequence after the removed row moves by one.
    const survivors = Array.from({ length: 12 }, (_, index) => index).filter(index => index !== 5)
      .map((index, position) => row(`k${index}`, position + 1, index === 3 ? 'Reply 3 changed' : `Reply ${index}`));
    const next = applyHistoryPage(applyTimelineReplacement(before, 'epoch-two'), tail('epoch-two', [...survivors, userRow('n1', survivors.length + 1, 'Brand new')])).state;
    await rerender(container, <AgentTimeline state={next} />);

    // k11 carried the avatar of the latest answer; a new turn begins with n1, so that avatar comes to rest.
    expect(new Set(renders.mock.calls.map(call => call[0]))).toEqual(new Set(['k3', 'k11', 'n1']));
    const after = new Map([...container.querySelectorAll<HTMLElement>('.agent-timeline-entry')].map(node => [node.dataset.entryKey, node]));
    expect(container.querySelector('.agent-timeline-entries')).toBe(entries);
    expect([...after.keys()]).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k6', 'k7', 'k8', 'k9', 'k10', 'k11', 'n1']);
    for (const key of after.keys()) if (key !== 'n1') expect(after.get(key)).toBe(nodes.get(key));
    expect(after.get('k3')?.textContent).toContain('Reply 3 changed');
    expect(errors.mock.calls.filter(call => String(call[0]).includes('same key'))).toEqual([]);
    errors.mockRestore();
  });

});

describe('a message being sent', () => {
  it('renders no row of the conversation again, and a running status changes only the last turn', async () => {
    const rows = Array.from({ length: 30 }, (_, turn) => [userRow(`p${turn}`, turn * 2 + 1, `Question ${turn}`), row(`a${turn}`, turn * 2 + 2, `Answer ${turn}`)])
      .flat().map(entry => ({ ...entry, turnId: `turn-${entry.seqStart}` }));
    const agent = (running: boolean) => ({ id: 'agent', providerId: 'copilot', createdAt: '2026-11-16T00:00:00Z', updatedAt: '2026-11-16T00:00:00Z',
      status: running ? 'running' as const : 'idle' as const, activeTurn: running ? { turnId: 'turn-59', startedAt: '2026-11-16T00:00:00Z' } : null, pendingInteractions: [],
      capabilities: { history: true, sendMessage: true, steer: false, cancel: true, readResource: true, interactions: { question: true, toolApproval: true, planApproval: true } },
      runtimeInfo: { providerId: 'copilot', sessionId: 'native', status: running ? 'running' as const : 'idle' as const } });
    const before = { ...initial(rows), agent: agent(false) };
    const container = await render(<AgentTimeline state={before} />);
    expect(turnRenders.mock.calls.length).toBeGreaterThanOrEqual(30);
    renders.mockClear(); turnRenders.mockClear();
    const sending = { ...before, outgoingMessages: [{ id: 'o1', agentId: 'agent', text: 'One more', status: 'sending' }] } as typeof before;
    await rerender(container, <AgentTimeline state={sending} />);
    expect(container.querySelector('[data-delivery-state]')).not.toBeNull();
    expect(renders).not.toHaveBeenCalled();
    // The last turn holds what follows the conversation (requests, the live line), so it may render; no other does.
    expect(turnRenders.mock.calls.length).toBeLessThanOrEqual(1);
    turnRenders.mockClear();
    const running = { ...sending, agent: agent(true) };
    const earlier = container.querySelector('.agent-turn');
    await rerender(container, <AgentTimeline state={running} />);
    expect(renders).not.toHaveBeenCalled();
    expect(turnRenders.mock.calls.length).toBeLessThanOrEqual(1);
    expect([...container.querySelectorAll('.agent-turn')].map(turn => turn.getAttribute('data-turn-state')).filter(state => state === 'running')).toHaveLength(1);
    expect([...container.querySelectorAll('.agent-turn')].at(-1)?.getAttribute('data-turn-state')).toBe('running');
    expect(container.querySelector('.agent-turn')).toBe(earlier);
  });
});
