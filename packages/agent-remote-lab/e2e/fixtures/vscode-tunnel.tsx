import { createRoot } from 'react-dom/client';
import { HostVscodeTunnel } from '../../src/components/HostVscodeTunnel.js';
import { LabWorkbench } from '../../src/components/LabWorkbench.js';
import { HttpVscodeTunnelClient, VscodeTunnelScope } from '../../src/vscode-tunnel.js';
import { replicaState } from '../../src/test/fixtures.js';
import '@agent-remote-controller/agent-remote-web/styles.css';
import '../../src/app.css';

const state = { ...replicaState, agent: { ...replicaState.agent!, cwd: '/Users/me/My project#1' } };
createRoot(document.getElementById('root')!).render(
  <VscodeTunnelScope host={{ id: 'desktop', name: 'My Mac', online: true, access: 'owner' }} service={new HttpVscodeTunnelClient(location.origin)}>
    <main className="lab-shell" style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'start', padding: 16, gap: 16 }}>
      <aside style={{ width: 300, maxWidth: '100%', flexShrink: 0 }}><HostVscodeTunnel /></aside>
      <div style={{ flex: '1 1 320px', minWidth: 0, height: 480 }}><LabWorkbench state={state} sessionStatus="ready" actions={{}} /></div>
    </main>
  </VscodeTunnelScope>,
);
