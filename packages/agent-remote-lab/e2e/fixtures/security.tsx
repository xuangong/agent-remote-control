import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GatewayController } from '../../src/GatewayController.js';
import { HostSecurityActions } from '../../src/components/HostSecurityActions.js';
import { HostCodexDaemon } from '../../src/components/HostCodexDaemon.js';
import type { RemoteHost } from '../../src/kernel/remote-host.js';
import type { AccountFacts } from '../../src/account.js';
import { RemoteHostClient } from '../../src/directory-client.js';
import '../../src/ui/tokens.css';
import '../../src/app.css';

const host: RemoteHost = { id: 'studio', name: 'Studio Mac', managed: true, credentialRotation: true, online: true, access: 'owner', providers: [{ providerId: 'codex', displayName: 'Codex', ...(new URLSearchParams(location.search).has('daemon-control') ? { daemonControl: true as const } : {}) }] };
function Conversation({ account, baseUrl }: { account?: AccountFacts; baseUrl: string }) {
  const [settings, setSettings] = useState(false);
  const [side, setSide] = useState(false);
  const [service] = useState(() => new RemoteHostClient(baseUrl));
  return <main style={{ padding: '64px 16px 24px' }}>
    <h1>Session conversation</h1>
    <label htmlFor="draft">Message draft</label><textarea id="draft" defaultValue="Unsent draft" />
    <button onClick={() => setSide(true)}>Open side conversation</button>
    {side ? <aside>Side conversation remains open</aside> : null}
    <button onClick={() => setSettings(value => !value)}>Settings</button>
    {settings ? <section aria-label="Controller settings">{account ? <><span className="gateway-account-identity">{account.name}</span><button type="button" disabled={!account.ready} onClick={account.openSecurity}>Security</button><button type="button" onClick={account.signOut}>Sign out</button></> : null}<HostSecurityActions service={service} host={host} /><HostCodexDaemon service={service} host={host} /></section> : null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<GatewayController>{(baseUrl, account) => <Conversation baseUrl={baseUrl} {...(account ? { account } : {})} />}</GatewayController>);
