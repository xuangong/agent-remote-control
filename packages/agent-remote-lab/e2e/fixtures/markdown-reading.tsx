import { useLayoutEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import { ReadingPositions, RecoveryScope } from '../../src/conversation-recovery.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const binding = { locator: './diagram.png', resourceId: 'diagram', status: 'available' as const };
const metadata = { status: 'available' as const, mediaType: 'image/png', byteLength: 1024, sha256: 'diagram', imageDimensions: { width: 1200, height: 600 } };
const cached = new URLSearchParams(location.search).has('cached');
const paragraphs = Array.from({ length: 40 }, (_, index) => `Paragraph ${index}. ${'This is readable Markdown content with **emphasis** and an inline `code` example. '.repeat(5)}`);
const markdown = ['# Reading position', ...paragraphs.slice(0, 3), '![Delayed diagram](./diagram.png)', ...paragraphs.slice(3)].join('\n\n');
const initial: AgentReplicaState = { ...replicaState,
  resources: cached ? { diagram: metadata } : {},
  timeline: { ...replicaState.timeline, hasOlder: false, nextSeq: 2, entries: [{
    providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-20T00:00:00Z', sourceSeqRanges: [], collapsed: [],
    resources: cached ? [binding] : [], item: { type: 'assistant_message', text: markdown },
  }] },
};
const transfer = new Promise<void>(() => {});
let resolveMetadata: () => void;
const metadataReady = cached ? Promise.resolve() : new Promise<void>(resolve => { resolveMetadata = resolve; });

function Fixture() {
  const [state, setState] = useState(initial);
  const [generation, setGeneration] = useState(0);
  const positions = useMemo(() => new ReadingPositions('markdown-reading'), []);
  useLayoutEffect(() => {
    const frame = document.querySelector('.agent-markdown-image')!;
    document.documentElement.dataset.initialImageHeight = String(frame.getBoundingClientRect().height);
  }, [generation]);
  useLayoutEffect(() => {
    const reveal = () => {
      setState(current => ({ ...current, resources: { diagram: metadata } }));
      resolveMetadata?.();
    };
    const remount = () => setGeneration(value => value + 1);
    window.addEventListener('fixture-metadata', reveal);
    window.addEventListener('fixture-remount', remount);
    return () => { window.removeEventListener('fixture-metadata', reveal); window.removeEventListener('fixture-remount', remount); };
  }, []);
  return <RecoveryScope.Provider value={positions}><div style={{ height: '100dvh' }}><LabWorkbench key={generation} state={state} sessionStatus="ready" actions={{
    sendMessage: async () => {},
    resolveResource: async () => { await metadataReady; return binding; },
    requestResource: () => transfer,
  }} /></div></RecoveryScope.Provider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
