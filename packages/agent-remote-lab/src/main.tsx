import { lazy, Suspense, StrictMode } from 'react';
import { deviceChoices } from './kernel/device-choices.js';
import { MotionProvider, browserMotionPort } from '@orchardworks/agent-client-web/primitives';
import { createRoot } from 'react-dom/client';

import { WorkspaceShell } from './features/windows/WorkspaceShell.js';
import { GatewayController } from './GatewayController.js';
import { previousWorkspacePath } from './kernel/workspace-access.js';
import { startDeviceStore } from './device-store-start.js';
import { loadChunkWithRecovery } from './chunk-recovery.js';
import { keepInstalledAppStorage } from './kernel/installed-app.js';
import { keepInstallPrompt } from './kernel/app-install.js';
import { registerAppShell } from './app-shell/register.js';
const gatewayMode = document.querySelector('meta[name="agent-remote-auth"]')?.getAttribute('content') === 'gateway';
// The installed app asks to keep its storage before it reads any, so a week away does not cost it its conversations or pending messages.
void keepInstalledAppStorage();
// The browser may offer installation before anything renders; Settings offers it from then on.
keepInstallPrompt();
// A production build starts from its stored shell whatever the network does, and takes a new build at the next launch (app-shell.ts).
registerAppShell(window, import.meta.env.PROD);
// The application chunk waits at most a second for the stored conversations, so its first render already reads them.
const storedConversations = Promise.race([startDeviceStore(gatewayMode), new Promise<void>(resolve => setTimeout(resolve, 1000))]);
const loadApp = () => loadChunkWithRecovery(() => Promise.all([import('./App.js'), storedConversations]).then(([module]) => ({ default: module.App })));
const appModule = previousWorkspacePath() ? loadApp() : undefined;
const App = lazy(() => appModule ?? loadApp());
import { trackFocusModality } from './kernel/focus-modality.js';
import './session-view-styles.js';

// The stored appearance, language and motion are shown before anything renders, so the first paint already has them.
const choices = deviceChoices();

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
// One motion subscription for the page: every avatar and mark reads reduced motion and visibility from it.
createRoot(root).render(<StrictMode><MotionProvider port={browserMotionPort(window, choices.motion)}>{gatewayMode
  ? <GatewayController automaticAccess={devbox}>{(baseUrl, account) => <Suspense fallback={shell}><App baseUrl={baseUrl} {...(account ? { account } : {})} userScoped /></Suspense>}</GatewayController>
  : <Suspense fallback={shell}><App fixtureAction={fixtureAction} /></Suspense>}</MotionProvider></StrictMode>);
