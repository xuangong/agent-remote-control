import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './app.css';
import '@borgee/agent-remote-web/styles.css';

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

createRoot(root).render(<StrictMode><App fixtureAction={fixtureAction} /></StrictMode>);
