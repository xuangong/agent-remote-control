import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionWorkbench } from '../../src/components/SessionWorkbench';
import { replicaState } from '../../src/test/fixtures';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import '../../src/session-view-styles';
import '../../src/ask.css';

const tokenScope = new URLSearchParams(window.location.search).get('usageScope') === 'runtime' ? 'runtime' : 'session';

const state: AgentReplicaState = {
  ...replicaState,
  timeline: { ...replicaState.timeline, hasOlder: false },
  agent: {
    ...replicaState.agent!, status: 'running', activeTurn: { turnId: 'turn', startedAt: new Date().toISOString() },
    capabilities: {
      ...replicaState.agent!.capabilities, steer: true, cancel: true, commands: true, planning: true, sessionSettings: true,
      imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 },
    },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, model: 'gpt-6-astra', status: 'running', planning: { active: false }, settings: [
      { id: 'model', category: 'model', label: 'Model', value: 'gpt-6-astra', options: [{ value: 'gpt-6-astra', label: 'GPT-6-Astra' }], mutable: true, scope: 'session' },
      { id: 'effort', category: 'model', label: 'Reasoning effort', value: 'ultra', options: [{ value: 'ultra', label: 'ultra' }], mutable: true, scope: 'session' },
      { id: 'approval', category: 'permissions', label: 'Approval policy', value: 'never', options: [{ value: 'never', label: 'Never ask' }], mutable: true, scope: 'session' },
      { id: 'sandbox', category: 'permissions', label: 'Sandbox', value: 'dangerFullAccess', options: [{ value: 'dangerFullAccess', label: 'Full access' }], mutable: true, scope: 'session' },
    ] },
    lastUsage: { tokenScope, inputTokens: 6_100, outputTokens: 622_500, cachedInputTokens: 305_300_000,
      cacheCreationInputTokens: 0, totalTokens: 305_928_600, contextScope: 'current', contextWindowUsedTokens: 82_400, contextWindowMaxTokens: 128_000 },
  },
};

function Fixture() {
  const [width, setWidth] = useState(440);
  const [height, setHeight] = useState(560);
  return <main className="lab-shell" style={{ display: 'block', position: 'static', height: 'auto', overflow: 'visible' }}>
    <nav aria-label="Fixture size">
      <label>Width<input aria-label="View width" type="number" value={width} onChange={event => setWidth(Number(event.target.value))} /></label>
      <label>Height<input aria-label="View height" type="number" value={height} onChange={event => setHeight(Number(event.target.value))} /></label>
    </nav>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'start' }}>
      {['primary', 'side', 'popup'].map((placement, index) => <section key={placement} data-placement={placement}
        className={placement === 'side' ? 'lab-side-conversation' : placement === 'popup' ? 'lab-ask-window' : 'lab-primary-conversation'}
        style={{ width, height, flex: 'none', minWidth: 0, padding: 0, border: 0, position: 'relative' }}>
        <SessionWorkbench state={{ ...state, agent: { ...state.agent!, id: `fixture-${index}` } }} sessionStatus="ready"
          conversationPath={<strong>Session fixture</strong>} sessionManager={<div><button type="button">Manage</button></div>} messageDraft="A draft kept while the view resizes"
          actions={{ sendMessage: async () => {}, sendMessageContent: async () => {}, cancel: async () => {}, listCommands: async () => [{ id: 'review', name: 'review', description: 'Review a change while keeping the conversation visible.', kind: 'skill' }] }} />
      </section>)}
    </div>
  </main>;
}

createRoot(document.getElementById('root')!).render(<Fixture />);
