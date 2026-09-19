import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { MessagePart } from '@agent-remote-controller/agent-remote-protocol';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ReadingPositions, RecoveryScope } from '../../src/conversation-recovery.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@agent-remote-controller/agent-remote-web/styles.css';

const scope = new ReadingPositions('image-browser-fixture');
function Fixture() {
  const [session, setSession] = useState('one');
  const [ready, setReady] = useState(true);
  const [fail, setFail] = useState(false);
  const [sent, setSent] = useState<readonly MessagePart[]>([]);
  const state = { ...replicaState, agent: { ...replicaState.agent!, id: session, status: 'idle' as const, activeTurn: null,
    capabilities: { ...replicaState.agent!.capabilities, imageInput: { mediaTypes: ['image/png', 'image/jpeg', 'image/webp'] as const, maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } } };
  return <RecoveryScope.Provider value={scope}><div style={{ height: '100dvh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto' }}>
    <nav><button onClick={() => setSession(value => value === 'one' ? 'two' : 'one')}>Switch session</button><button onClick={() => setReady(value => !value)}>Toggle connection</button><button onClick={() => setFail(value => !value)}>Toggle upload failure</button></nav>
    <LabWorkbench state={{ ...state, agent: { ...state.agent, capabilities: { ...state.agent.capabilities, imageInput: { ...state.agent.capabilities.imageInput, mediaTypes: [...state.agent.capabilities.imageInput.mediaTypes] } } } }} sessionStatus={ready ? 'ready' : 'catching_up'} draftSessionKey={session} actions={{
      sendMessage: async text => { setSent([{ type: 'text', text }]); },
      sendMessageContent: async content => { setSent([...content]); },
      uploadImage: async (file, uploadId, options) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (options?.signal?.aborted) throw new DOMException('Paused', 'AbortError');
        if (fail) throw new Error('Fixture upload failed. Retry this image.');
        const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
        return { attachmentId: uploadId, sha256, byteLength: file.size, mediaType: 'image/png', imageDimensions: { width: 1, height: 1 } };
      },
    }} />
    <pre data-testid="sent-content" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(sent)}</pre>
  </div></RecoveryScope.Provider>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
