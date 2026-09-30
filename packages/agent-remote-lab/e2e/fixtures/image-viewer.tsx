import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import { PreviewWorkspace, TimelineDisplay } from '@orchardworks/agent-remote-web/react';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ReadingPositions, RecoveryScope } from '../../src/conversation-recovery.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const imageBytes = new Uint8Array(await (await fetch(new URL('./markdown-wide.png', import.meta.url))).arrayBuffer());
const options = new URLSearchParams(location.search);
const locator = options.has('native-image')
  ? `${options.get('native-image') === 'claude' ? 'claude' : 'codex'}-image:viewer-image` : './viewer.png';
const binding = { locator, resourceId: 'viewer-image', status: 'available' as const };
const image = {
  status: 'available' as const, mediaType: 'image/png', byteLength: imageBytes.length, sha256: 'viewer-image',
  imageDimensions: { width: 1200, height: 600 }, contentBase64: btoa(Array.from(imageBytes, byte => String.fromCharCode(byte)).join('')),
};
const paragraphs = Array.from({ length: 16 }, (_, index) => `Paragraph ${index}. ${'Keep this reading position while inspecting an image. '.repeat(4)}`);
const markdown = [
  '# Conversation image', ...paragraphs.slice(0, 4), `![Viewer diagram](${locator})`,
  `[Open diagram file](${locator})`, ...paragraphs.slice(4),
].join('\n\n');
const initialState: AgentReplicaState = {
  ...replicaState,
  agent: { ...replicaState.agent!, status: 'idle', activeTurn: null },
  resources: { [binding.resourceId]: image },
  timeline: { ...replicaState.timeline, hasOlder: false, nextSeq: 4, entries: [
    { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-09-30T00:00:00Z', sourceSeqRanges: [], collapsed: [],
      resources: [binding], item: { type: 'assistant_message', text: markdown } },
    { providerId: 'recorded', seqStart: 2, seqEnd: 2, timestamp: '2026-09-30T00:00:01Z', sourceSeqRanges: [], collapsed: [],
      resources: [], item: { type: 'user_message', text: 'Inspect [image #1]',
        content: [{ type: 'text', text: 'Inspect ' }, { type: 'image', label: 'image #1', locator: binding.locator }] } },
    { providerId: 'recorded', seqStart: 3, seqEnd: 3, timestamp: '2026-09-30T00:00:02Z', sourceSeqRanges: [], collapsed: [],
      resources: [], item: { type: 'assistant_message', text: options.has('tail')
        ? `![Latest diagram](${locator})` : paragraphs.slice(0, 3).join('\n\n') } },
  ] },
};

const positions = new ReadingPositions('image-viewer-fixture');
function Fixture() {
  const [state, setState] = useState(initialState);
  useEffect(() => {
    const append = () => setState(previous => {
      const seq = previous.timeline.nextSeq;
      return { ...previous, timeline: { ...previous.timeline, nextSeq: seq + 1, entries: [...previous.timeline.entries, {
        providerId: 'recorded', seqStart: seq, seqEnd: seq, timestamp: '2026-09-30T00:01:00Z', sourceSeqRanges: [], collapsed: [],
        resources: [], item: { type: 'assistant_message', text: `New message after image preview\n\n${paragraphs.slice(0, 8).join('\n\n')}` },
      }] } };
    });
    Object.assign(window, { appendImageViewerMessage: append });
    return () => { delete (window as Window & { appendImageViewerMessage?: () => void }).appendImageViewerMessage; };
  }, []);
  return <TimelineDisplay.Provider value={options.has('content') ? 'content' : 'preview'}><RecoveryScope.Provider value={positions}>
    <PreviewWorkspace style={{ height: '100dvh' }} resourceScope="image-viewer-fixture">
      <LabWorkbench state={state} sessionStatus="ready" actions={{
        sendMessage: async () => {}, resolveResource: async () => binding, requestResource: async () => image,
      }} />
    </PreviewWorkspace>
  </RecoveryScope.Provider></TimelineDisplay.Provider>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
