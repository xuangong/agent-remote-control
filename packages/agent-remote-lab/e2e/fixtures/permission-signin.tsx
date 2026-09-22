import { createRoot } from 'react-dom/client';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/app.css';
import '@orchardworks/agent-remote-web/styles.css';

const state = { ...replicaState, pendingInteractions: [], agent: { ...replicaState.agent!, status: 'idle' as const, activeTurn: null,
  capabilities: { ...replicaState.agent!.capabilities, sessionSettings: true },
  runtimeInfo: { ...replicaState.agent!.runtimeInfo, settings: [{ id: 'sandbox', category: 'permissions' as const, label: 'Sandbox', value: 'readOnly', mutable: true, scope: 'session' as const,
    options: [{ value: 'readOnly', label: 'Read only' }, { value: 'dangerFullAccess', label: 'Full access' }] }] } } };

createRoot(document.getElementById('root')!).render(<div className="lab-shell" style={{ display: 'block' }}>
  <LabWorkbench state={state} sessionStatus="ready" messageDraft="Keep my draft" actions={{ setSessionSetting: async () => {
    throw Object.assign(new Error('Sign in again before changing session permissions. Then retry the change.'), { code: 'reauthentication_required' });
  } }} />
</div>);
