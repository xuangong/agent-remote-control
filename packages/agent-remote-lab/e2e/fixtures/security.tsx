import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { GatewayController } from '../../src/GatewayController.js';
import { HostPairing } from '../../src/components/HostPairing.js';
import { RemoteHostClient } from '../../src/directory-client.js';
import '../../src/app.css';

function Conversation({ accountAction, baseUrl }: { accountAction: ReactNode; baseUrl: string }) {
  const [settings, setSettings] = useState(false);
  const [side, setSide] = useState(false);
  const [service] = useState(() => new RemoteHostClient(baseUrl));
  return <main style={{ padding: '64px 16px 24px' }}>
    <h1>Session conversation</h1>
    <label htmlFor="draft">Message draft</label><textarea id="draft" defaultValue="Unsent draft" />
    <button onClick={() => setSide(true)}>Open side conversation</button>
    {side ? <aside>Side conversation remains open</aside> : null}
    <button onClick={() => setSettings(value => !value)}>Settings</button>
    {settings ? <section aria-label="Controller settings">{accountAction}<HostPairing service={service} selectedHostId="studio" hosts={[{ id: 'studio', name: 'Studio Mac', managed: true, credentialRotation: true, online: true, access: 'owner' }]} onSelect={() => undefined} onRetryHosts={() => undefined} /></section> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<GatewayController>{(baseUrl, accountAction) => <Conversation baseUrl={baseUrl} accountAction={accountAction} />}</GatewayController>);
