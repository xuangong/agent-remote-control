// Settings > Audit (bots design 7): the real audit over an in-memory chain client. Three chains of a chief, a standing tracker
// and a temporary worker; one passed two thresholds and holds an approval of the person's, one was stopped. What the person decides is recorded on `window.auditActions`
// and changes the view the next list returns. The words follow the browser's language.
import { createRoot } from 'react-dom/client';
import type { BotChain, ChainAction, ChainView } from '@orchardworks/agent-remote-protocol';
import { LocaleProvider } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { BotAudit } from '../../src/features/settings/BotAudit.js';
import '../../src/session-view-styles';
import '../../src/features/settings/settings.css';
import './orchard-primitives.css';

const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32), worker: 'b_' + '3'.repeat(32) };
const now = Date.now();
const chain = (id: string, extra: Partial<BotChain> = {}): BotChain => ({ id, cause: 'person', bot: ids.chief, bots: [ids.chief, ids.tracker, ids.worker],
  messages: 14, turns: 9, created: 2, subSessions: 3, depth: 4, usage: { tokens: 248_000 }, startedAt: now - 600_000, updatedAt: now - 60_000, ...extra });
let view: ChainView = {
  chains: [chain('c_0000000000000001', { passed: ['tokens', 'depth'], approvals: [{ cwd: '/Users/someone/projects/agent-remote-control/packages/agent-remote-lab', at: now - 300_000, applied: 3 }] }), chain('c_0000000000000002', { cause: 'routine', bot: ids.tracker, bots: [ids.tracker], messages: 1, turns: 1, created: 0, depth: 0, usage: { tokens: 3_100 } }),
    chain('c_0000000000000003', { stopped: now - 120_000, messages: 3, turns: 2, created: 1, depth: 1, usage: { tokens: 18_000 } })],
  paused: [], thresholds: { tokens: 200_000 },
  names: { [ids.chief]: 'Chief of staff', [ids.tracker]: 'Release tracker', [ids.worker]: 'Log reviewer' },
};
if (new URLSearchParams(location.search).has('empty')) view = { ...view, chains: [] };
const actions: ChainAction[] = (window as unknown as { auditActions: ChainAction[] }).auditActions = [];
const client = {
  list: async () => view,
  act: async (action: ChainAction) => {
    actions.push(action);
    if (action.action === 'stop') view = { ...view, chains: view.chains.map(item => item.id === action.chainId ? { ...item, stopped: Date.now() } : item) };
    if (action.action === 'revoke_approval') view = { ...view, chains: view.chains.map(item => item.id === action.chainId ? { ...item, approvals: [] } : item) };
    if (action.action === 'pause_bot') view = { ...view, paused: [...view.paused, action.botId] };
    if (action.action === 'resume_bot') view = { ...view, paused: view.paused.filter(bot => bot !== action.botId) };
    if (action.action === 'set_thresholds') view = { ...view, thresholds: action.thresholds };
  },
};
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}>
  <main className="lab-settings" aria-label="Audit" style={{ padding: 16, maxWidth: 720 }}><BotAudit baseUrl="/" client={client} /></main>
</LocaleProvider>);
