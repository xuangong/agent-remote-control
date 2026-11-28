// A bot's routines in its details, and Settings > Unattended work (routines design 10): the real components over in-memory state. Five routines
// of a standing bot: a weekday check that costs a little, a paused one, one the Relay keeps for open work, one held by the budget, and one
// that skipped a run. What the person does is recorded on `window.routineActions` and changes what is shown next. `?settings` shows the settings page.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import type { ChainAction, ChainView, Routine } from '@orchardworks/agent-remote-protocol';
import { LocaleProvider } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { RoutinesList } from '../../src/conversation/assistant/RoutinesList.js';
import { UnattendedSettings } from '../../src/features/settings/UnattendedSettings.js';
import '../../src/session-view-styles';
import '../../src/features/settings/settings.css';
import '../../src/conversation/assistant/assistant.css';
import './orchard-primitives.css';

const now = Date.now(), chief = 'b_' + '1'.repeat(32);
const base = { anchor: now - 86_400_000, runCount: 0 } as const;
let routines: Routine[] = [
  { ...base, id: 'r1', name: 'Morning check', by: 'bot', schedule: { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '08:30' }, model: 'claude-haiku-4-5', dueAt: now + 5 * 3_600_000, runCount: 2,
    runs: [{ n: 1, trigger: 'schedule', dueAt: now - 86_400_000, state: 'done', usd: 0.0214, tokens: 48_000 }, { n: 2, trigger: 'schedule', dueAt: now - 600_000, state: 'running', missed: 2 }] },
  { ...base, id: 'r2', name: 'Weekly summary', by: 'person', schedule: { kind: 'weekdays', days: [5], time: '17:00' }, paused: true, runs: [] },
  { ...base, id: 'r3', name: 'work', by: 'system', work: true, schedule: { kind: 'quiet', minutes: 30 }, dueAt: now + 1_200_000, runs: [] },
  { ...base, id: 'r4', name: 'Look at the failing build and tell me what changed since yesterday, in one paragraph', by: 'person', schedule: { kind: 'every', minutes: 180 }, dueAt: now + 3_600_000, runCount: 1,
    runs: [{ n: 1, trigger: 'schedule', dueAt: now - 3_600_000, state: 'skipped', reason: 'budget' }] },
  { ...base, id: 'r6', name: 'Deploy failed', by: 'person', schedule: { kind: 'event' }, hook: { id: 'a'.repeat(12), hash: 'b'.repeat(64) }, events: ['{"service":"api"}', '{"service":"web"}'], runs: [], runCount: 0 },
  { ...base, id: 'r5', name: 'Quarter check', by: 'person', schedule: { kind: 'once', at: now + 86_400_000 * 20 }, dueAt: now + 86_400_000 * 20, runs: [] },
];
if (new URLSearchParams(location.search).has('empty')) routines = [];
const actions: unknown[] = (window as unknown as { routineActions: unknown[] }).routineActions = [];
const view = (): ChainView => ({ chains: [], paused: [], thresholds: {}, names: { [chief]: 'Chief of staff' }, unattended: { settings: { budget: { perDay: 5, perMonth: 60 }, timeZone: 'Asia/Shanghai', prices: {} }, timeZone: 'Asia/Shanghai', day: '2026-11-30',
  today: { usd: 5.4, bots: { [chief]: { usd: 5.4, tokens: 1_840_000, turns: 12, runs: 7 } } }, month: { usd: 22.15, bots: { [chief]: { usd: 22.15, tokens: 9_100_000, turns: 80, runs: 44 } } },
  limits: [{ provider: 'mac/claude', resetsAt: now + 3 * 3_600_000 }], tripped: [{ scope: 'account', period: 'day' }], unpriced: ['my-local-model'] } });
const client = { list: async () => view(), act: async (action: ChainAction) => { actions.push(action); } };

function Details() {
  const [, bump] = useState(0);
  const change = async (record: unknown, apply: () => void) => { actions.push(record); apply(); bump(count => count + 1); };
  return <main className="lab-settings lab-assistant-details-body" aria-label="Routines" style={{ padding: 16, maxWidth: 560 }}><RoutinesList choice={{ routines, zone: 'Asia/Shanghai', hold: 'budget', botPaused: false, models: [{ value: 'default', label: 'Default' }, { value: 'sonnet', label: 'Sonnet' }, { value: 'haiku', label: 'Haiku' }],
    hookUrl: token => `https://relay.example/hooks/ns/${token}`, rotateHook: name => change({ rotate: name }, () => undefined).then(() => ({ token: 'abc123abc123.' + 'x'.repeat(43) })),
    pauseBot: paused => change({ pauseBot: paused }, () => undefined),
    save: spec => change({ save: spec }, () => { routines = [...routines.filter(item => item.name !== spec.name), { ...base, id: spec.name, name: spec.name, by: 'person', schedule: spec.schedule, runs: [], ...(spec.workspace ? { workspace: spec.workspace } : {}), ...(spec.prompt ? { prompt: spec.prompt } : {}) }]; }).then(() => spec.schedule.kind === 'event' ? { token: 'abc123abc123.' + 'y'.repeat(43) } : undefined),
    pause: (name, paused) => change({ pause: [name, paused] }, () => { routines = routines.map(item => item.name === name ? (paused ? { ...item, paused: true as const } : (({ paused: _p, ...rest }) => rest)(item)) : item); }),
    remove: name => change({ remove: name }, () => { routines = routines.filter(item => item.name !== name); }),
    test: name => change({ test: name }, () => { routines = routines.map(item => item.name === name ? { ...item, runs: [...item.runs, { n: item.runCount + 1, trigger: 'test' as const, dueAt: Date.now(), state: 'waiting' as const }] } : item); }) }} /></main>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}>
  {new URLSearchParams(location.search).has('settings') ? <main className="lab-settings" aria-label="Unattended work" style={{ padding: 16, maxWidth: 720 }}><UnattendedSettings baseUrl="/" client={client} /></main> : <Details />}
</LocaleProvider>);
