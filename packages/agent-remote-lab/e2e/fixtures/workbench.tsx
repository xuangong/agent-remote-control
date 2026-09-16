import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentReplicaState } from '@agent-remote-controller/agent-remote-web';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@agent-remote-controller/agent-remote-web/styles.css';

function entry(seq: number): AgentReplicaState['timeline']['entries'][number] {
  return { providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: '2026-09-02T00:00:05.000Z', sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], resources: [], item: { type: 'assistant_message', text: `Message ${seq}.\n\n${'Readable conversation content. '.repeat(16)}`, messageId: `message-${seq}` } };
}
const initial = { ...replicaState, timeline: { ...replicaState.timeline, entries: Array.from({ length: 30 }, (_, index) => entry(index + 20)), nextSeq: 50 } };

function WorkbenchFixture() {
  const [state, setState] = useState(initial);
  const [visible, setVisible] = useState(true);
  const [loading, setLoading] = useState(false);
  const resolveHistory = useRef<() => void>();
  const append = () => setState((current) => ({ ...current, timeline: { ...current.timeline, nextSeq: current.timeline.nextSeq + 1, entries: [...current.timeline.entries, entry(current.timeline.nextSeq)] } }));
  function loadOlder(): Promise<void> {
    setLoading(true);
    return new Promise((resolve) => { resolveHistory.current = resolve; });
  }
  function finishHistory() {
    setState((current) => ({ ...current, timeline: { ...current.timeline, nextSeq: current.timeline.nextSeq + 1, hasOlder: false, entries: [...Array.from({ length: 20 }, (_, index) => entry(index)), ...current.timeline.entries, entry(current.timeline.nextSeq)] } }));
    setLoading(false);
    resolveHistory.current?.();
  }
  return <div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
    <nav aria-label="Fixture updates" style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      <button onClick={append}>Append live</button>
      <button onClick={() => setState((current) => ({ ...current, timeline: { ...current.timeline, entries: current.timeline.entries.map((item, index, all) => index === all.length - 1 && item.item.type === 'assistant_message' ? { ...item, item: { ...item.item, text: `${item.item.text}\n\n${'Streaming content. '.repeat(40)}` } } : item) } }))}>Grow last message</button>
      <button onClick={() => setVisible((value) => !value)}>Toggle Trace</button>
      <button onClick={() => setState((current) => ({ ...current, timeline: { ...current.timeline, epoch: `${current.timeline.epoch}-replaced` } }))}>Replace epoch</button>
      <button onClick={() => setState((current) => ({ ...current, agent: { ...current.agent!, id: `${current.agent!.id}-next` } }))}>Switch Agent</button>
      <button disabled={!loading} onClick={finishHistory}>Complete history with live</button>
    </nav>
    <section hidden={!visible} style={{ minHeight: 0 }}><LabWorkbench state={state} sessionStatus="ready" visible={visible} actions={{ loadOlder, sendMessage: async () => {} }} /></section>
    <section hidden={visible}>Trace fixture</section>
  </div>;
}

createRoot(document.getElementById('root')!).render(<WorkbenchFixture />);
