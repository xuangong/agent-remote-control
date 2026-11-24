// The board in a standing bot's details (bots plan 8g): the real details over an in-memory Relay board. The chief has a plan note, a tree of
// items (one assigned to a standing staff bot with a board of its own, one to a temporary bot), and finished items. The person's edits are
// recorded on `window.boardWrites`; item 2 is stale on the page (the Relay already holds a newer status), so saving it says what it replaced.
// `?surface=sheet` shows the details as the phone's sheet. The words follow the browser's language.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Board, BoardItem, BoardItemEdit, BoardWriteResult } from '@orchardworks/agent-remote-protocol';
import { LocaleProvider } from '@orchardworks/agent-client-web/react';
import { bindLanguage } from '@orchardworks/agent-client-web/browser';
import { AssistantDetails, type AssistantRef } from '../../src/conversation/assistant/AssistantDetails.js';
import type { BoardChoice } from '../../src/conversation/assistant/board-model.js';
import '../../src/session-view-styles';
import './orchard-primitives.css';

const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32), regression: 'b_' + '3'.repeat(32) };
const names: Record<string, string> = { [ids.chief]: 'Chief of staff', [ids.tracker]: 'Release tracker', [ids.regression]: 'Regression run' };
const now = Date.now();
const item = (key: number, extra: Partial<BoardItem>): BoardItem => ({ key, title: `Item ${key}`, status: 'open', assignee: 'self', links: [], version: 1, changedAt: {}, updatedBy: ids.chief, updatedAt: now - 600_000, ...extra });
const chief: Board = { next: 9, plan: { text: 'Cut the 2.0 release: tracker watches the build, a temporary bot runs the regression, and the notes follow once both are green.', version: 2,
  changes: [{ at: now - 3_600_000, by: ids.chief, why: 'The build broke on Tuesday, so the tracker comes first.' }, { at: now - 7_200_000, by: 'person', why: 'You asked for the release this week.' }] },
  items: [
    item(1, { title: 'Release 2.0 end to end, with the changelog and the announcement text for the customers', status: 'working', assignee: ids.tracker, report: 'Build is red on main: the retry timer test fails on the CI runner.',
      brief: 'Cut the 2.0 release and keep the person posted.', links: [{ kind: 'branch', value: 'release/2.0-with-a-long-branch-name-that-must-wrap-on-a-phone' }, { kind: 'pr', value: 'https://github.com/example/product/pull/1234' }] }),
    item(2, { title: 'Write the release notes', parent: 1, status: 'open', assignee: 'self', brief: 'Three fixes and one new command.' }),
    item(3, { title: 'Run the regression suite', parent: 1, status: 'working', assignee: ids.regression, report: 'Half of the suites ran.', brief: 'Run every suite on release/2.0.' }),
    item(4, { title: 'Update the website', status: 'done', result: 'Deployed.', closedAt: now - 86_400_000 }),
    item(5, { title: 'Drop the beta banner', status: 'cancelled', closedAt: now - 90_000_000 })] };
const tracker: Board = { next: 3, plan: { text: 'Poll the build every minute and tell the chief when main turns red.', version: 1, changes: [] },
  items: [item(1, { title: 'Poll main every minute', status: 'working', assignee: 'self', updatedBy: ids.tracker }), item(2, { title: 'Report a red build to the chief', assignee: ids.regression })] };

// What the Relay holds: item 2 was set to waiting by the tracker after the page read it.
let relay: Board = structuredClone(chief);
relay.items[1] = { ...relay.items[1]!, status: 'waiting', version: 2, changedAt: { status: 2 }, updatedBy: ids.tracker };
const writes: unknown[] = (window as unknown as { boardWrites: unknown[] }).boardWrites = [];
const opened: string[] = (window as unknown as { openedBots: string[] }).openedBots = [];

function write(edit: { items?: readonly BoardItemEdit[]; plan?: { text: string; why: string; version?: number } }): BoardWriteResult {
  const result: BoardWriteResult = { items: [] };
  for (const change of edit.items ?? []) {
    if (change.key === undefined) {
      const key = relay.next++;
      relay.items = [...relay.items, item(key, { title: change.title!, assignee: change.assignee ?? 'self', ...(change.brief ? { brief: change.brief } : {}), ...(typeof change.parent === 'number' ? { parent: change.parent } : {}), updatedBy: 'person' })];
      result.items.push({ key, version: 1 });
      continue;
    }
    const current = relay.items.find(entry => entry.key === change.key)!;
    const stale = change.version! < current.version && change.status !== undefined && change.status !== current.status;
    relay.items = relay.items.map(entry => entry.key !== change.key ? entry : { ...entry, ...(change.title ? { title: change.title } : {}), ...(change.status ? { status: change.status } : {}),
      ...(change.assignee ? { assignee: change.assignee } : {}), ...(change.brief ? { brief: change.brief } : {}), version: entry.version + 1, updatedBy: 'person', updatedAt: Date.now() });
    result.items.push({ key: change.key!, version: current.version + 1, ...(stale ? { overwrote: [{ field: 'status' as const, was: current.status, by: current.updatedBy }] } : {}) });
  }
  if (edit.plan) {
    relay.plan = { text: edit.plan.text, version: relay.plan!.version + 1, changes: [...relay.plan!.changes, { at: Date.now(), by: 'person', why: edit.plan.why }] };
    result.plan = { version: relay.plan.version };
  }
  return result;
}

function Fixture() {
  const [shown, setShown] = useState<Board>(chief);
  const sheet = new URLSearchParams(location.search).get('surface') === 'sheet';
  const choice: BoardChoice = { board: shown, name: id => names[id] ?? id, choices: [{ botId: ids.tracker, name: names[ids.tracker]! }, { botId: ids.regression, name: names[ids.regression]! }],
    staffBoard: id => id === ids.tracker ? tracker : undefined, canOpen: () => true, open: id => { opened.push(id); },
    save: async edit => { writes.push(edit); const result = write(edit); setShown(structuredClone(relay)); return result; } };
  const assistant: AssistantRef = { id: ids.chief, name: names[ids.chief]!, role: 'Coordinator', board: choice };
  return sheet ? <AssistantDetails assistant={assistant} surface="sheet" onClose={() => {}} />
    : <aside aria-label="Details" style={{ width: 320, padding: 12 }} className="lab-assistant-details"><AssistantDetails assistant={assistant} surface="panel" onClose={() => {}} /></aside>;
}
createRoot(document.getElementById('root')!).render(<LocaleProvider language={bindLanguage(document, localStorage, window)}><Fixture /></LocaleProvider>);
