import { describe, expect, it } from 'vitest';

import { recording, recordingNames, type RecordedProvider } from './test-utils/recordings.js';
import { continuityOutcome, itemsOf, journalOfRun, type ContinuityOutcome } from './test-utils/journal-continuity.js';

/**
 * Sessions as the real CLIs recorded them: what a journal built from the live run does when the session is read again. Each recording is
 * a scenario of its provider's recorder; the title of a test says the outcome it asserts, so a change of an adapter or of a CLI is a
 * visible change of a test name. A provider without fixtures is skipped, and a fixture that no test names fails.
 */
const UNCHANGED: ContinuityOutcome = { outcome: 'unchanged' };
const CHANGED: ContinuityOutcome = { outcome: 'replaced', reason: 'changed' };
const OPEN_ITEM: ContinuityOutcome = { outcome: 'replaced', reason: 'open_item' };

/** The recordings each provider's tests below name, so none is recorded and forgotten. */
const named: Record<RecordedProvider, Set<string>> = { copilot: new Set(), codex: new Set(), claude: new Set() };
const unchangedOnReopen = (provider: RecordedProvider, names: string[]) => { for (const name of names) named[provider].add(name); return names; };
const use = (provider: RecordedProvider, name: string) => { named[provider].add(name); return recording(provider, name); };

const keyKind = (key: string) => key.replace(/:.*$/, '');
const liveOnlyKinds = async (provider: RecordedProvider, names: string[]) =>
  [...new Set((await Promise.all(names.map(async name => (await journalOfRun(recording(provider, name).live)).liveOnlyKeys().map(keyKind)))).flat())].sort();

describe.each(['copilot', 'codex', 'claude'] as const)('journal continuity of %s, from the recordings of the real CLI', provider => {
  const names = recordingNames(provider);
  const present = (...wanted: string[]) => wanted.filter(name => names.includes(name));

  describe.skipIf(names.length === 0)('every recording', () => {
    it('gives every row an identity and none a key the Controller keeps for itself', async () => {
      for (const name of names) {
        const items = [...await itemsOf(recording(provider, name).live), ...await itemsOf(recording(provider, name).reread)];
        expect(items.length, name).toBeGreaterThan(0);
        expect(items.filter(({ key }) => key.startsWith('controller:')), name).toEqual([]);
      }
    });

    it('opened five times adds no item after the first, and leaves none open', async () => {
      for (const name of names) {
        const run = recording(provider, name);
        const journal = await journalOfRun(run.live);
        await journal.reread(run.reread);
        const keys = journal.keys();
        for (let open = 0; open < 5; open += 1) expect(await journal.reread(run.reread), `${name}, open ${open + 1}`).toEqual(UNCHANGED);
        expect(journal.keys(), name).toEqual(keys);
        expect(journal.openKeys().filter(key => !key.startsWith('tool:')), name).toEqual([]);
      }
    });
  });

  if (provider === 'codex') codexScenarios(present);
  if (provider === 'copilot') copilotScenarios();
  if (provider === 'claude') claudeScenarios(present);

  // Defined last, so it runs after the scenarios above have named their recordings.
  it('has a test for every recording it has', () => {
    expect(names.filter(name => !named[provider].has(name)), `the recordings of ${provider} that no test names`).toEqual([]);
  });
});

function codexScenarios(present: (...wanted: string[]) => string[]): void {
  describe.skipIf(present('settled').length === 0)('Codex', () => {
    it.each(unchangedOnReopen('codex', ['settled', 'restart', 'reasoning', 'steer', 'after-reopen', 'plan-mode', 'approval', 'todos', 'compaction', 'errors']))('%s: reopening gives unchanged, and a second reread adds nothing', async name => {
      const run = use('codex', name);
      const journal = await journalOfRun(run.live);
      expect(journal.openKeys()).toEqual([]);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('settled: a turn is streamed text, a command, a file change and an answer, each one item', async () => {
      const keys = (await journalOfRun(use('codex', 'settled').live)).keys().map(key => key.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, '<id>'));
      expect(keys).toEqual(['user:<id>', 'assistant:m1', 'tool:c1', 'tool:p1', 'assistant:m2', 'user:<id>', 'assistant:m3']);
    });

    it('reasoning: two summary parts streamed with their blank line equal what history joins', async () => {
      const run = use('codex', 'reasoning');
      const joined = run.reread.flatMap(({ event }) => event.type === 'timeline' && event.item.type === 'reasoning' ? [event.item.text] : []);
      expect(joined).toEqual(['Part one\n\nPart two']);
      expect(await continuityOutcome(run)).toEqual(UNCHANGED);
    });

    it('approval: the question and the approval, which native history does not hold, stay in the journal as live-only items', async () => {
      const run = use('codex', 'approval');
      const journal = await journalOfRun(run.live);
      const before = journal.keys();
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.keys()).toEqual(before);
      expect(journal.liveOnlyKeys()).toEqual(['interaction:q1', 'interaction:c1']);
      expect(run.reread.some(({ event }) => event.type === 'interaction_resolved' || (event.type === 'timeline' && event.item.type === 'interaction'))).toBe(false);
    });

    it('todos: two plan updates are one live-only item, and the reread holds none', async () => {
      const run = use('codex', 'todos');
      const journal = await journalOfRun(run.live);
      expect(journal.keys().filter(key => key === 'todo')).toEqual(['todo']);
      expect(journal.liveOnlyKeys()).toEqual(['todo']);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.liveOnlyKeys()).toEqual(['todo']);
      expect(run.reread.some(({ event }) => event.type === 'timeline' && event.item.type === 'todo')).toBe(false);
    });

    it('plan-mode: the plan shown as a message while it streamed is the item history lists, so a plan turn reopens unchanged', async () => {
      const run = use('codex', 'plan-mode');
      const journal = await journalOfRun(run.live);
      expect(journal.keys().filter(key => key.startsWith('assistant:'))).toHaveLength(2);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.keys().filter(key => key.startsWith('assistant:'))).toHaveLength(2);
    });

    it('compaction: the compaction is one item, and history keeps everything before it', async () => {
      const run = use('codex', 'compaction');
      const journal = await journalOfRun(run.live);
      expect(journal.compactionStatuses()).toEqual(['completed']);
      expect(journal.keys().filter(key => key.startsWith('compaction:'))).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('errors: a failed turn is one error item in both, and a failing MCP server is one live-only item', async () => {
      const run = use('codex', 'errors');
      const journal = await journalOfRun(run.live);
      expect(journal.keys().filter(key => key.startsWith('turn-error:'))).toHaveLength(1);
      expect(journal.keys().filter(key => key.startsWith('error:'))).toEqual([]);
      expect(journal.liveOnlyKeys()).toEqual(['startup:broken']);
    });

    it('correction: a final that does not continue the stream replaces the journal once, as a changed item, and the correction item is gone', async () => {
      const run = use('codex', 'correction');
      const journal = await journalOfRun(run.live);
      expect(journal.keys().filter(key => key.endsWith(':correction'))).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(CHANGED);
      expect(journal.keys().filter(key => key.endsWith(':correction'))).toEqual([]);
      expect(journal.keys().filter(key => key === 'assistant:m1')).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('interrupted: nothing streamed stays open, the command that was under way stays open until history reports it failed, then one changed and settled', async () => {
      const run = use('codex', 'interrupted');
      const journal = await journalOfRun(run.live);
      expect(journal.openKeys()).toEqual(['tool:c1']);
      expect(journal.keys().filter(key => key.startsWith('assistant:') || key.startsWith('reasoning:'))).toHaveLength(2);
      expect(await journal.reread(run.reread)).toEqual(CHANGED);
      expect(journal.openKeys()).toEqual([]);
      for (let open = 0; open < 5; open += 1) expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a tool that completed while the Controller was away replaces the journal once, as an open item', async () => {
      const run = use('codex', 'settled');
      const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity?.key === 'tool:c1' && itemIdentity.completes === true);
      expect(completes).toBeGreaterThan(0);
      const journal = await journalOfRun(run.live.slice(0, completes));
      expect(journal.openKeys().filter(key => key.startsWith('tool:'))).toEqual(['tool:c1']);
      expect(await journal.reread(run.reread)).toEqual(OPEN_ITEM);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session that grew while the Controller was away appends the newest items of its reread', async () => {
      const run = use('codex', 'settled');
      const firstTurn = run.live.findIndex(({ event }) => event.type === 'turn_completed') + 1;
      const grown = (await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })))).length;
      const known = (await itemsOf(run.live.slice(0, firstTurn))).length;
      const journal = await journalOfRun(run.live.slice(0, firstTurn));
      expect(known).toBeLessThan(grown);
      expect(await journal.newest(run.reread, grown - known + 1)).toEqual({ outcome: 'appended' });
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session whose reread lost an item the journal holds replaces the journal, as a changed item', async () => {
      const run = use('codex', 'settled');
      const lastUser = run.reread.map(({ event }) => event.type === 'timeline' && event.item.type === 'user_message').lastIndexOf(true);
      expect(await continuityOutcome({ live: run.live, reread: run.reread.slice(0, lastUser) })).toEqual(CHANGED);
    });

    it('the live-only items of the recordings are the plan board and the interactions, and an error that history does not hold', async () => {
      expect(await liveOnlyKinds('codex', present('settled', 'reasoning', 'approval', 'todos', 'plan-mode', 'compaction', 'interrupted', 'correction', 'steer', 'errors'))).toEqual(['interaction', 'startup', 'todo']);
    });
  });
}

function copilotScenarios(): void {
  const live = (name: string) => use('copilot', name);
  describe.skipIf(recordingNames('copilot').length === 0)('Copilot', () => {
    it.each(unchangedOnReopen('copilot', ['settled', 'restart', 'reasoning', 'approval', 'todos', 'compaction', 'interrupted', 'partial-tool']))('%s: reopening gives unchanged, and a second reread adds nothing', async name => {
      const run = live(name);
      const journal = await journalOfRun(run.live);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.openKeys()).toEqual([]);
    });

    it('approval: the question the reread cannot reproduce stays in the journal, live-only, and a tool approval does not', async () => {
      const run = live('approval');
      const journal = await journalOfRun(run.live);
      const before = journal.keys();
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.keys()).toEqual(before);
      const resolved = run.live.filter(({ event }) => event.type === 'interaction_resolved').map(({ itemIdentity }) => itemIdentity);
      expect(resolved.map(identity => identity?.liveOnly === true)).toEqual([true, false, false]);
      expect(journal.liveOnlyKeys()).toEqual([resolved[0]!.key]);
    });

    it('todos: the live-only snapshot survives the reopen and the reread holds none', async () => {
      const run = live('todos');
      const journal = await journalOfRun(run.live);
      const snapshots = journal.liveOnlyKeys();
      expect(snapshots).toEqual(['todo']);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.liveOnlyKeys()).toEqual(snapshots);
      expect(run.reread.some(({ event }) => event.type === 'timeline' && event.item.type === 'todo')).toBe(false);
    });

    it('reasoning: the native history does not keep it, so the journal keeps the streamed copy as live-only', async () => {
      const run = live('reasoning');
      const journal = await journalOfRun(run.live);
      expect(journal.liveOnlyKeys().filter(key => key.startsWith('reasoning:'))).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.liveOnlyKeys().filter(key => key.startsWith('reasoning:'))).toHaveLength(1);
    });

    it('compaction: a failed one ends as failed, beside an error item', async () => {
      const journal = await journalOfRun(live('compaction').live);
      expect(journal.compactionStatuses()).toEqual(['completed', 'failed']);
      expect(journal.keys().filter(key => key.startsWith('compaction:'))).toHaveLength(2);
      expect(journal.keys().filter(key => key.startsWith('error:'))).toHaveLength(1);
      expect(journal.openKeys()).toEqual([]);
    });

    it('interrupted: the text that streamed before the cancel is kept live-only and no item stays open', async () => {
      const run = live('interrupted');
      const journal = await journalOfRun(run.live);
      expect(journal.liveOnlyKeys().filter(key => key.startsWith('assistant:'))).toHaveLength(1);
      expect(journal.openKeys()).toEqual([]);
      for (let reopen = 0; reopen < 5; reopen += 1) expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('partial-tool: a tool that streamed output reads the same, because its last row carries the whole result', async () => {
      const run = live('partial-tool');
      const streamed = run.live.filter(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'running');
      expect(streamed.length).toBeGreaterThan(1);
      expect(await continuityOutcome(run)).toEqual(UNCHANGED);
    });

    it('a tool that completed while the Controller was away replaces the journal once, as an open item', async () => {
      const run = live('partial-tool');
      const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity?.key.startsWith('tool:') && itemIdentity.completes === true);
      expect(completes).toBeGreaterThan(0);
      const journal = await journalOfRun(run.live.slice(0, completes));
      expect(journal.openKeys().filter(key => key.startsWith('tool:'))).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(OPEN_ITEM);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session that grew while the Controller was away appends the newest items of its reread', async () => {
      const run = live('settled');
      const firstTurn = run.live.findIndex(({ event }) => event.type === 'turn_completed') + 1;
      const grown = (await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })))).length;
      const known = (await itemsOf(run.live.slice(0, firstTurn))).length;
      const journal = await journalOfRun(run.live.slice(0, firstTurn));
      expect(known).toBeLessThan(grown);
      expect(await journal.newest(run.reread, grown - known + 1)).toEqual({ outcome: 'appended' });
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session whose reread lost an item the journal holds replaces the journal, as a changed item', async () => {
      const run = live('settled');
      const lastUser = run.reread.map(({ event }) => event.type === 'timeline' && event.item.type === 'user_message').lastIndexOf(true);
      expect(await continuityOutcome({ live: run.live, reread: run.reread.slice(0, lastUser) })).toEqual(CHANGED);
    });
  });
}

function claudeScenarios(present: (...wanted: string[]) => string[]): void {
  describe.skipIf(present('settled').length === 0)('Claude Code', () => {
    it.each(unchangedOnReopen('claude', ['settled', 'restart', 'after-reopen', 'thinking', 'approval', 'plan-approval', 'todos', 'steer', 'queued', 'interrupted', 'parallel-tools', 'images', 'hook', 'slash-command', 'subagent']))('%s: reopening gives unchanged, and a second reread adds nothing', async name => {
      const run = use('claude', name);
      const journal = await journalOfRun(run.live);
      expect(journal.openKeys()).toEqual([]);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('settled: a tool row reread from the transcript equals the live one, so a reopened session keeps its file diffs', async () => {
      const run = use('claude', 'settled');
      const toolRows = (observations: typeof run.live) => observations.flatMap(({ event, itemIdentity }) => event.type === 'timeline' && event.item.type === 'tool_call' && event.item.status === 'completed' ? [[itemIdentity?.key, JSON.stringify(event.item.result)] as const] : []);
      expect(toolRows(run.reread)).toEqual(toolRows(run.live));
      expect(toolRows(run.reread).some(([, result]) => result.includes('file_changes'))).toBe(true);
    });

    it('approval: the question and the permission prompt, which the transcript never held, stay in the journal as live-only items', async () => {
      const run = use('claude', 'approval');
      const journal = await journalOfRun(run.live);
      const before = journal.keys();
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.keys()).toEqual(before);
      expect(journal.liveOnlyKeys().map(key => key.replace(/:[0-9a-f-]{36}$/, ''))).toEqual(['interaction:claude:ask-1', 'interaction:claude:write-1']);
    });

    it('thinking: the thinking block the SDK read keeps is not live-only', async () => {
      const journal = await journalOfRun(use('claude', 'thinking').live);
      expect(journal.liveOnlyKeys()).toEqual([]);
      expect(journal.keys().filter(key => key.startsWith('reasoning:'))).toHaveLength(1);
    });

    it('steer and images: input folded into a running turn keeps its uuid, its place and its image', async () => {
      for (const name of ['steer', 'images']) {
        const run = use('claude', name);
        const folded = (observations: typeof run.live) => observations.flatMap(({ event, itemIdentity }) => event.type === 'timeline' && event.item.type === 'user_message' && /FOLDED/.test(event.item.text) ? [[itemIdentity?.key, event.item.text, JSON.stringify(event.item.content ?? null)] as const] : []);
        expect(folded(run.live)).toHaveLength(1);
        expect(folded(run.reread), name).toEqual(folded(run.live));
      }
    });

    it('compaction: the compaction costs one changed replacement, because the chain restarts at the boundary, and then settles', async () => {
      const run = use('claude', 'compaction');
      const journal = await journalOfRun(run.live);
      expect(journal.compactionStatuses()).toEqual(['completed']);
      expect(journal.keys().filter(key => key.startsWith('compaction:'))).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(CHANGED);
      expect(journal.compactionStatuses()).toEqual([]);
      for (let open = 0; open < 5; open += 1) expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('failed-compaction: a compaction that never reached its boundary ends failed, beside the error the CLI printed, which is live-only', async () => {
      const run = use('claude', 'failed-compaction');
      const journal = await journalOfRun(run.live);
      expect(journal.compactionStatuses()).toEqual(['failed']);
      expect(journal.openKeys()).toEqual([]);
      expect(journal.liveOnlyKeys()).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(CHANGED);
      expect(journal.liveOnlyKeys()).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('withdrawn: input removed from the native queue stays visible until the next reopen, which replaces once and drops it', async () => {
      const run = use('claude', 'withdrawn');
      const journal = await journalOfRun(run.live);
      const withdrawn = journal.keys().filter(key => key.startsWith('user:')).length;
      expect(await journal.reread(run.reread)).toEqual(CHANGED);
      expect(journal.keys().filter(key => key.startsWith('user:')).length).toBe(withdrawn - 1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('slash-command: a built-in that prints its own output keeps it as a live-only item the SDK read omits, and the typed row equals the transcript row', async () => {
      const run = use('claude', 'slash-command');
      const journal = await journalOfRun(run.live);
      expect(journal.liveOnlyKeys()).toHaveLength(1);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
      expect(journal.liveOnlyKeys()).toHaveLength(1);
    });

    it('subagent: the sidechain is absent and the parent tool row has equal keys, and the wake-up row the stream never shows is not in the reread', async () => {
      const run = use('claude', 'subagent');
      expect(run.reread.some(({ event }) => event.type === 'timeline' && event.item.type === 'user_message' && event.item.text.includes('<task-notification>'))).toBe(false);
      const parent = (observations: typeof run.live) => observations.flatMap(({ itemIdentity }) => itemIdentity?.key === 'tool:task-1' ? [itemIdentity.key] : []);
      expect(new Set(parent(run.reread))).toEqual(new Set(parent(run.live)));
      expect(JSON.stringify(run.live)).not.toContain('SUBAGENT_DONE');
    });

    it('parallel-tools: two tool calls of one message keep their order and block indices', async () => {
      const run = use('claude', 'parallel-tools');
      const journal = await journalOfRun(run.live);
      expect(journal.keys().filter(key => key.startsWith('tool:'))).toEqual(['tool:par-1', 'tool:par-2']);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('interrupted: an interrupted turn leaves no item open, the partial text history keeps is the live text, and five reopens are unchanged', async () => {
      const run = use('claude', 'interrupted');
      const journal = await journalOfRun(run.live);
      expect(journal.openKeys()).toEqual([]);
      for (let open = 0; open < 5; open += 1) expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a tool that completed while the Controller was away replaces the journal once, as an open item', async () => {
      const run = use('claude', 'settled');
      const completes = run.live.findIndex(({ itemIdentity }) => itemIdentity?.key === 'tool:write-1' && itemIdentity.completes === true);
      expect(completes).toBeGreaterThan(0);
      const journal = await journalOfRun(run.live.slice(0, completes));
      expect(journal.openKeys().filter(key => key.startsWith('tool:'))).toEqual(['tool:write-1']);
      expect(await journal.reread(run.reread)).toEqual(OPEN_ITEM);
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session that grew while the Controller was away appends the newest items of its reread', async () => {
      const run = use('claude', 'settled');
      const firstTurn = run.live.findIndex(({ event }) => event.type === 'turn_completed') + 1;
      const grown = (await itemsOf(run.reread.map(observation => ({ ...observation, delivery: 'history' as const })))).length;
      const known = (await itemsOf(run.live.slice(0, firstTurn))).length;
      const journal = await journalOfRun(run.live.slice(0, firstTurn));
      expect(known).toBeLessThan(grown);
      expect(await journal.newest(run.reread, grown - known + 1)).toEqual({ outcome: 'appended' });
      expect(await journal.reread(run.reread)).toEqual(UNCHANGED);
    });

    it('a session whose reread lost an item the journal holds replaces the journal, as a changed item', async () => {
      const run = use('claude', 'settled');
      const lastUser = run.reread.map(({ event }) => event.type === 'timeline' && event.item.type === 'user_message').lastIndexOf(true);
      expect(await continuityOutcome({ live: run.live, reread: run.reread.slice(0, lastUser) })).toEqual(CHANGED);
    });

    it('the live-only items of the recordings are the interactions and what a local command prints, and nothing else', async () => {
      const kinds = await liveOnlyKinds('claude', present('settled', 'thinking', 'approval', 'plan-approval', 'todos', 'steer', 'queued', 'interrupted', 'parallel-tools', 'images', 'hook', 'slash-command', 'subagent'));
      expect(kinds).toEqual(['assistant', 'interaction']);
    });
  });
}
