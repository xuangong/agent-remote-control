import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { GatewayController } from './GatewayController.js';
const App = lazy(() => import('./App.js').then(module => ({ default: module.App })));
import { trackFocusModality } from './focus-modality.js';
import './app.css';
import '@orchardworks/agent-remote-web/styles.css';

const stopTrackingFocus = trackFocusModality(document);
if (import.meta.hot) import.meta.hot.dispose(stopTrackingFocus);

const root = document.getElementById('root');
if (!root) throw new Error('Lab root element is missing.');

const fixtureEndpoint = import.meta.env.VITE_AGENT_REMOTE_FIXTURE_ENDPOINT as string | undefined;
const fixtureAction = fixtureEndpoint ? async (
  agentId: string,
  action: 'advance' | 'rehydrate' | 'stop-reader',
): Promise<void> => {
  const response = await fetch(`${fixtureEndpoint}/${encodeURIComponent(agentId)}/${action}`, { method: 'POST' });
  if (!response.ok) throw new Error(`Lab scenario action failed with HTTP ${response.status}.`);
} : undefined;

const gatewayMode = document.querySelector('meta[name="agent-remote-auth"]')?.getAttribute('content') === 'gateway';
createRoot(root).render(<StrictMode><Suspense fallback={<div className="lab-empty-state" role="status">Opening workspace…</div>}>{gatewayMode
  ? <GatewayController>{(baseUrl, accountAction) => <App baseUrl={baseUrl} accountAction={accountAction} userScoped />}</GatewayController>
  : <App fixtureAction={fixtureAction} />}</Suspense></StrictMode>);
