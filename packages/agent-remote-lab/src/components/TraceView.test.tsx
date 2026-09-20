import { act, useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { AgentReplicaState } from '@agent-remote-controller/agent-remote-web';
import type { ProjectedTimelineEntry } from '@agent-remote-controller/agent-remote-protocol';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { TraceView } from './TraceView.js';

const entry: ProjectedTimelineEntry = {
  providerId: 'recorded', turnId: 'turn-one', seqStart: 3, seqEnd: 7,
  timestamp: '2026-09-17T00:00:00Z', sourceSeqRanges: [{ startSeq: 3, endSeq: 3 }, { startSeq: 7, endSeq: 7 }],
  collapsed: ['tool_lifecycle'], resources: [],
  item: { type: 'tool_call', callId: 'read-file', name: 'read_file', status: 'completed', error: null,
    detail: { type: 'read', filePath: '/workspace/answer.md' }, result: { durationMs: 123, exitCode: 0, truncated: true, content: [{ type: 'text', text: 'The answer is 42.' }] } },
};
const state: AgentReplicaState = { ...replicaState, timeline: { ...replicaState.timeline, hasOlder: false, entries: [entry,
  { ...entry, seqStart: 8, seqEnd: 8, turnId: 'turn-two', item: { type: 'assistant_message', text: 'Finished.', messageId: 'reply' } },
] } };

function button(container: Element, text: string) {
  const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes(text));
  expect(result, `Button containing ${text}`).toBeDefined();
  return result!;
}

describe('TraceView', () => {
  it('consumes navigation once and preserves filters, selection, and reading position on tab changes', async () => {
    let show!: (visible: boolean) => void;
    let reveal!: () => void;
    function Harness() {
      const [visible, setVisible] = useState(true);
      const [requestId, setRequestId] = useState(1);
      show = setVisible; reveal = () => setRequestId(value => value + 1);
      return <TraceView state={state} visible={visible} revealEntry={{ key: 'epoch-1:recorded:3:read-file', requestId }} />;
    }
    const container = await render(<Harness />);
    await act(async () => button(container, 'Finished.').click());
    const filter = container.querySelector<HTMLSelectElement>('[aria-label="Trace event type"]')!;
    await act(async () => { filter.value = 'assistant_message'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
    const details = container.querySelector<HTMLElement>('[aria-label="Trace entry details"]')!;
    details.scrollTop = 80;
    await act(async () => show(false));
    await act(async () => show(true));
    expect(filter.value).toBe('assistant_message');
    expect(details.textContent).toContain('Finished.');
    expect(details.scrollTop).toBe(80);
    await act(async () => reveal());
    expect(filter.value).toBe('all');
    expect(details.textContent).toContain('The answer is 42.');
    expect(details.scrollTop).toBe(0);
  });

  it('inspects normalized inputs, results, and source ranges, then locates the conversation entry', async () => {
    let destination: string | undefined;
    const container = await render(<TraceView state={state} onShowConversation={key => { destination = key; }} />);
    await act(async () => button(container, 'read_file').click());
    const details = container.querySelector('[aria-label="Trace entry details"]')!;
    expect(details).not.toBeNull();
    expect(details.textContent).toContain('/workspace/answer.md');
    expect(details.textContent).toContain('The answer is 42.');
    expect(details.textContent).toContain('3, 7');
    expect(details.textContent).toContain('Tool lifecycle');
    expect(details.textContent).toContain('123 ms');
    expect(details.textContent).toContain('Result truncated');
    await act(async () => button(details, 'Show in Conversation').click());
    expect(destination).toBe('epoch-1:recorded:3:read-file');
  });

  it('filters by content and type without changing the replica or losing turn association', async () => {
    const container = await render(<TraceView state={state} />);
    const search = container.querySelector<HTMLInputElement>('[aria-label="Search trace"]');
    expect(search).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'answer.md');
      search!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-trace-entry-key]')).toHaveLength(1);
    expect(container.querySelector('.lab-trace-list')?.textContent).toContain('turn-one');
    const type = container.querySelector<HTMLSelectElement>('[aria-label="Trace event type"]')!;
    await act(async () => { type.value = 'assistant_message'; type.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelectorAll('[data-trace-entry-key]')).toHaveLength(0);
    expect(container.textContent).toContain('No matching events');
    expect(state.timeline.entries).toHaveLength(2);
  });

  it('keeps the selected tool through lifecycle updates and reports an unavailable selection', async () => {
    let update!: (state: AgentReplicaState) => void;
    function Harness() { const [value, setValue] = useState(state); update = setValue; return <TraceView state={value} />; }
    const container = await render(<Harness />);
    await act(async () => button(container, 'read_file').click());
    await act(async () => update({ ...state, timeline: { ...state.timeline, entries: [{ ...entry, seqEnd: 11,
      item: { ...entry.item as Extract<typeof entry.item, { type: 'tool_call' }>, result: { content: [{ type: 'text', text: 'Updated output' }] } },
    }] } }));
    expect(container.querySelector('[aria-label="Trace entry details"]')?.textContent).toContain('Updated output');
    await act(async () => update({ ...state, timeline: { ...state.timeline, entries: [] } }));
    expect(container.textContent).toContain('This event is no longer in the loaded timeline');
  });

  it('shows only running explicit agent waits as current dependencies and preserves unknown targets', async () => {
    const waiting: ProjectedTimelineEntry = { ...entry, item: { type: 'tool_call', callId: 'wait-one', name: 'agent.wait', status: 'running', error: null,
      detail: { type: 'other', description: 'Waiting for agent updates:', sessionReferences: [{ nativeSessionId: 'child-one', title: '/root/tests' }] } } };
    const completed = { ...waiting, seqStart: 9, item: { ...waiting.item as Extract<typeof waiting.item, { type: 'tool_call' }>, callId: 'wait-old', status: 'completed' as const, error: null } };
    const unknown = { ...waiting, seqStart: 10, item: { ...waiting.item as Extract<typeof waiting.item, { type: 'tool_call' }>, callId: 'wait-unknown', detail: { type: 'other' as const, description: 'Waiting for agent updates (target unavailable)' } } };
    const container = await render(<TraceView state={{ ...state, timeline: { ...state.timeline, entries: [waiting, completed, unknown] } }}
      sessionStatus="disconnected" resolveSessionLink={id => ({ href: `/session/${id}`, title: 'Tests', open: async () => {} })} />);
    const waits = container.querySelector('[aria-label="Agent waits"]');
    expect(waits).not.toBeNull();
    expect(waits!.querySelectorAll('[data-wait-call]')).toHaveLength(2);
    expect(waits!.querySelector('a')?.textContent).toBe('/root/tests');
    expect(waits!.querySelector('a')?.getAttribute('href')).toBe('/session/child-one');
    expect(waits!.textContent).toContain('target unavailable');
    expect(waits!.textContent).toContain('Last observed');
  });

  it('clears filters for a conversation deep link, and clears selection across session scopes', async () => {
    let reveal!: () => void;
    let changeSession!: () => void;
    function Harness() {
      const [scope, setScope] = useState('one');
      const [request, setRequest] = useState<{ key: string; requestId: number }>();
      reveal = () => setRequest({ key: 'epoch-1:recorded:3:read-file', requestId: 1 });
      changeSession = () => { setScope('two'); setRequest(undefined); };
      return <TraceView key={scope} state={state} revealEntry={request} />;
    }
    const container = await render(<Harness />);
    const filter = container.querySelector<HTMLSelectElement>('[aria-label="Trace event type"]')!;
    await act(async () => { filter.value = 'assistant_message'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(container.querySelectorAll('[data-trace-entry-key]')).toHaveLength(1);
    await act(async () => reveal());
    expect(container.querySelectorAll('[data-trace-entry-key]')).toHaveLength(2);
    expect(container.querySelector('[aria-label="Trace entry details"]')?.textContent).toContain('The answer is 42.');
    await act(async () => changeSession());
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    expect(container.querySelector('[aria-label="Trace entry details"]')?.textContent).not.toContain('The answer is 42.');
  });

  it('removes a current wait when its tool completes while keeping the result inspectable', async () => {
    let complete!: () => void;
    function Harness() {
      const [done, setDone] = useState(false);
      complete = () => setDone(true);
      return <TraceView sessionStatus="ready" state={{ ...state,
        agent: { ...state.agent!, activeTurn: { turnId: 'turn-one', startedAt: entry.timestamp } },
        timeline: { ...state.timeline, entries: [{ ...entry, item: { type: 'tool_call', callId: 'wait-one', name: 'agent.wait',
          status: done ? 'completed' : 'running', error: null,
          detail: { type: 'other', description: 'Waiting for tests', sessionReferences: [{ nativeSessionId: 'child', title: '/root/tests' }] },
          ...(done ? { result: { content: [{ type: 'text' as const, text: 'Tests agent finished' }] } } : {}),
        } }] },
      }} />;
    }
    const container = await render(<Harness />);
    const waits = container.querySelector('[aria-label="Agent waits"]')!;
    expect(waits.textContent).toContain('Waiting for');
    expect(waits.textContent).not.toContain('Last observed');
    expect(waits.querySelector('a')).toBeNull();
    await act(async () => button(waits, 'Inspect').click());
    await act(async () => complete());
    expect(container.querySelector('[aria-label="Agent waits"]')).toBeNull();
    expect(container.querySelector('[aria-label="Trace entry details"]')?.textContent).toContain('Tests agent finished');
  });
});

it('defers hidden trace creation and freezes hidden rows until the next reveal', async () => {
  let update!: (value: { visible: boolean; state: AgentReplicaState }) => void;
  function Harness() {
    const [value, setValue] = useState({ visible: false, state }); update = setValue;
    return <TraceView {...value} />;
  }
  const container = await render(<Harness />);
  expect(container.querySelector('[aria-label="Trace events"]')).toBeNull();
  await act(async () => update({ visible: true, state }));
  expect(container.textContent).toContain('Finished.');
  const next = { ...state, timeline: { ...state.timeline, entries: [entry] } };
  await act(async () => update({ visible: false, state: next }));
  expect(container.textContent).toContain('Finished.');
  await act(async () => update({ visible: true, state: next }));
  expect(container.textContent).not.toContain('Finished.');
});
