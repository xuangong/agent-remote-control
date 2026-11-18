import { createRoot } from 'react-dom/client';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ToastProvider } from '../../src/components/Toast.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

// A session whose native runtime is reconnecting: the workbench raises the recovery notice as a toast.
const reconnecting = { ...replicaState, agent: { ...replicaState.agent!, runtimeInfo: { ...replicaState.agent!.runtimeInfo, connection: { state: 'reconnecting' as const } } } };

createRoot(document.getElementById('root')!).render(<ToastProvider>
  <div style={{ height: '100dvh' }}><LabWorkbench state={reconnecting} sessionStatus="ready" visible actions={{ sendMessage: async () => {} }} /></div>
</ToastProvider>);
