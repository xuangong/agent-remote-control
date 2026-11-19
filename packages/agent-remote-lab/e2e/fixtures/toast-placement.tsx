import { createRoot } from 'react-dom/client';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { ToastProvider } from '../../src/components/Toast.js';
import { replicaState } from '../../src/test/fixtures.js';
import '../../src/session-view-styles';

// A ready session whose send is refused: the workbench raises the failure as a toast.
const refuse = async () => { throw new Error('The command was refused by the fixture.'); };

createRoot(document.getElementById('root')!).render(<ToastProvider>
  <div style={{ height: '100dvh' }}><LabWorkbench state={replicaState} sessionStatus="ready" visible actions={{ sendMessage: refuse, sendMessageContent: refuse }} /></div>
</ToastProvider>);
