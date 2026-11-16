import { lazy, Suspense, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { WorkspaceShell } from './components/WorkspaceShell.js';
import { GatewayController } from './GatewayController.js';
import { previousWorkspacePath } from './workspace-access.js';
import { startDeviceStore } from './device-store-start.js';
const gatewayMode = document.querySelector('meta[name="agent-remote-auth"]')?.getAttribute('content') === 'gateway';
// The application chunk waits at most a second for the stored conversations, so its first render already reads them.
const storedConversations = Promise.race([startDeviceStore(gatewayMode), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
const loadApp = () => Promise.all([import('./App.js'), storedConversations]).then(([module]) => ({ default: module.App }));
const appModule = previousWorkspacePath() ? loadApp() : undefined;
const App = lazy(() => appModule ?? loadApp());
import { trackFocusModality } from './focus-modality.js';
import './session-view-styles.js';

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

const devbox = document.querySelector('meta[name="agent-remote-devbox"]')?.getAttribute('content') === 'true';
const shell = <WorkspaceShell />;
createRoot(root).render(<StrictMode>{gatewayMode
  ? <GatewayController automaticAccess={devbox}>{(baseUrl, accountAction) => <Suspense fallback={shell}><App baseUrl={baseUrl} accountAction={accountAction} userScoped /></Suspense>}</GatewayController>
  : <Suspense fallback={shell}><App fixtureAction={fixtureAction} /></Suspense>}</StrictMode>);
