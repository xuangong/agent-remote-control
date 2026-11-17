import { describe, expect, it } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { projectCodexThreadHistory } from './history.js';
import { CodexEventProjector } from './projector.js';

const THREAD = 'thread-1';
const TURN = 'turn-1';

const user = { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'Do it' }], startedAtMs: 1 };
const reasoningItem = { type: 'reasoning', id: 'reasoning-1', summary: ['First part', 'Second part'], content: [], startedAtMs: 2 };
const messageItem = { type: 'agentMessage', id: 'message-1', text: 'Running it.', startedAtMs: 3 };
const command = { type: 'commandExecution', id: 'command-1', command: 'pwd', cwd: '/workspace', status: 'completed', aggregatedOutput: '/workspace\n', exitCode: 0, startedAtMs: 4 };
const fileChange = { type: 'fileChange', id: 'file-1', changes: [{ path: '/workspace/a.ts', kind: { type: 'add' }, diff: 'a\n' }], status: 'completed', startedAtMs: 5 };
const mcp = { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'search', status: 'completed', arguments: {}, result: { content: [{ type: 'text', text: 'found' }] }, startedAtMs: 6 };
const web = { type: 'webSearch', id: 'web-1', query: 'codex', status: 'completed', startedAtMs: 7 };
const compaction = { type: 'contextCompaction', id: 'compaction-1', startedAtMs: 8 };
const finalMessage = { type: 'agentMessage', id: 'message-2', text: 'Done.', startedAtMs: 9 };
const items = [user, reasoningItem, messageItem, command, fileChange, mcp, web, compaction, finalMessage];

const inProgress = (item: Record<string, unknown>) => ({ ...item, status: 'inProgress', aggregatedOutput: null, exitCode: null, result: null });
const lifecycle = (method: 'item/started' | 'item/completed', item: unknown) => [method, { threadId: THREAD, turnId: TURN, item }] as const;
const delta = (method: string, itemId: string, text: string, extra: object = {}) => [method, { threadId: THREAD, turnId: TURN, itemId, delta: text, ...extra }] as const;
const partAdded = (summaryIndex: number) => ['item/reasoning/summaryPartAdded', { threadId: THREAD, turnId: TURN, itemId: 'reasoning-1', summaryIndex }] as const;

/** What a live stream says for the items above: streamed text and reasoning, tools that start and complete, a compaction. */
const liveNotifications: Array<readonly [string, unknown]> = [
  lifecycle('item/started', user), lifecycle('item/completed', user),
  lifecycle('item/started', { ...reasoningItem, summary: [] }),
  partAdded(0), delta('item/reasoning/summaryTextDelta', 'reasoning-1', 'First part', { summaryIndex: 0 }),
  partAdded(1), delta('item/reasoning/summaryTextDelta', 'reasoning-1', 'Second part', { summaryIndex: 1 }),
  lifecycle('item/completed', reasoningItem),
  lifecycle('item/started', { ...messageItem, text: '' }),
  delta('item/agentMessage/delta', 'message-1', 'Running '), delta('item/agentMessage/delta', 'message-1', 'it.'),
  lifecycle('item/completed', messageItem),
  lifecycle('item/started', inProgress(command)), lifecycle('item/completed', command),
  lifecycle('item/started', inProgress(fileChange)), lifecycle('item/completed', fileChange),
  lifecycle('item/started', inProgress(mcp)), lifecycle('item/completed', mcp),
  lifecycle('item/started', inProgress(web)), lifecycle('item/completed', web),
  lifecycle('item/started', compaction), lifecycle('item/completed', compaction),
  lifecycle('item/started', { ...finalMessage, text: '' }), lifecycle('item/completed', finalMessage),
  ['turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed' } }],
];

const live = (notifications: ReadonlyArray<readonly [string, unknown]> = liveNotifications): ProviderObservation[] => {
  const projector = new CodexEventProjector(THREAD);
  return notifications.flatMap(([method, params]) => projector.projectNotifications(method, params));
};
const reread = (turnItems: unknown[] = items): ProviderObservation[] =>
  projectCodexThreadHistory({ thread: { id: THREAD, cwd: '/workspace', turns: [{ id: TURN, status: 'completed', startedAt: 1, items: turnItems }] } }, THREAD);

const timeline = (observations: ProviderObservation[]) => observations.filter(({ event }) => event.type === 'timeline');
const keys = (observations: ProviderObservation[]) => [...new Set(timeline(observations).map(({ itemIdentity }) => itemIdentity?.key))];
const body = ({ event }: ProviderObservation) => event.type === 'timeline' ? event.item : undefined;

describe('Codex item identity', () => {
  it('gives every timeline observation a key, equal for the same items live and in history, and never a controller or delta source key', () => {
    const fromStream = live();
    const fromHistory = reread();
    expect(timeline(fromStream).every(({ itemIdentity }) => itemIdentity !== undefined && itemIdentity.key.length > 0 && itemIdentity.key.length <= 4096)).toBe(true);
    expect(timeline(fromHistory).every(({ itemIdentity }) => itemIdentity !== undefined)).toBe(true);
    expect(keys(fromStream)).toEqual([
      'user:user-1', 'reasoning:reasoning-1', 'assistant:message-1', 'tool:command-1', 'tool:file-1', 'tool:mcp-1', 'tool:web-1', 'compaction:compaction-1', 'assistant:message-2',
    ]);
    expect(keys(fromHistory)).toEqual(keys(fromStream));
    expect([...keys(fromStream), ...keys(fromHistory)].filter(key => key?.startsWith('controller:') || key?.includes(':delta:'))).toEqual([]);
  });

  it('finishes every item once: a tool and a compaction repeat their whole content, a streamed text finishes with what it lacks', () => {
    const stream = timeline(live());
    const rows = (key: string) => stream.filter(({ itemIdentity }) => itemIdentity?.key === key);
    expect(rows('tool:command-1').map(({ itemIdentity }) => itemIdentity?.completes === true)).toEqual([false, true]);
    expect(rows('tool:command-1').map(row => (body(row) as { status: string }).status)).toEqual(['running', 'completed']);
    expect(rows('compaction:compaction-1').map(row => [(body(row) as { status: string }).status, row.itemIdentity?.completes === true])).toEqual([['loading', false], ['completed', true]]);
    expect(rows('assistant:message-1').map(row => [(body(row) as { text: string }).text, row.itemIdentity?.completes === true])).toEqual([['Running ', false], ['it.', false], ['', true]]);
    expect(rows('user:user-1').map(({ itemIdentity }) => itemIdentity?.completes === true)).toEqual([true]);
    // Native history holds finished items only, and every one of them says so.
    expect(timeline(reread()).every(({ itemIdentity }) => itemIdentity?.completes === true)).toBe(true);
  });

  it('streams a reasoning of several summary parts as the text history joins, so the reread equals it', () => {
    const streamed = timeline(live()).filter(({ itemIdentity }) => itemIdentity?.key === 'reasoning:reasoning-1').map(row => (body(row) as { text: string }).text);
    expect(streamed).toEqual(['First part', '\n\n', 'Second part', '']);
    expect(streamed.join('')).toBe('First part\n\nSecond part');
    const [history] = timeline(reread()).filter(({ itemIdentity }) => itemIdentity?.key === 'reasoning:reasoning-1');
    expect((body(history!) as { text: string }).text).toBe(streamed.join(''));
  });

  it('keeps a reasoning of one part and a reasoning with only content equal to history too', () => {
    const projector = new CodexEventProjector(THREAD);
    expect(projector.projectNotifications(...partAdded(0))).toEqual([]);
    const content = { type: 'reasoning', id: 'reasoning-2', summary: [], content: ['raw one', 'raw two'], startedAtMs: 1 };
    const [completed] = projector.projectNotifications(...lifecycle('item/completed', content));
    expect((body(completed!) as { text: string }).text).toBe('raw one\n\nraw two');
    expect(completed!.itemIdentity).toEqual({ key: 'reasoning:reasoning-2', completes: true });
  });

  it('marks as live-only exactly what native history cannot rebuild: the plan board and errors it does not hold', () => {
    const projector = new CodexEventProjector(THREAD);
    const everything = [
      ...projector.projectNotifications('turn/plan/updated', { threadId: THREAD, turnId: TURN, plan: [{ step: 'a', status: 'pending' }] }),
      ...projector.projectNotifications('error', { threadId: THREAD, turnId: TURN, error: { message: 'Transient trouble' }, willRetry: true }),
      ...projector.projectNotifications('thread/futureState/updated', { threadId: THREAD, futureState: 'x' }),
      ...projector.projectNotifications('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'futureTool', id: 'future-1' } }),
      ...live(), ...reread(),
    ];
    const liveOnly = timeline(everything).filter(({ itemIdentity }) => itemIdentity?.liveOnly === true).map(({ itemIdentity }) => itemIdentity!.key.replace(/^error:.*/, 'error:*'));
    expect([...new Set(liveOnly)].sort()).toEqual(['error:*', 'todo']);
    // The kind key of the board is not an occurrence key, and an error is keyed by its message.
    const same = () => projector.projectNotification('error', { threadId: THREAD, turnId: TURN, error: { message: 'Same words' }, willRetry: true })!;
    const first = same();
    expect(first.itemIdentity).toEqual(same().itemIdentity);
    expect(projector.projectNotification('error', { threadId: THREAD, turnId: TURN, error: { message: 'Other words' }, willRetry: true })!.itemIdentity!.key).not.toBe(first.itemIdentity!.key);
  });

  it('keys a failed turn the same in both paths, and an item type it does not know once, when it completes', () => {
    const projector = new CodexEventProjector(THREAD);
    const failure = projector.projectTurnFailure('boom', TURN);
    expect(failure.itemIdentity).toEqual({ key: `turn-error:${TURN}`, completes: true });
    const [fromHistory] = projectCodexThreadHistory({ thread: { id: THREAD, turns: [{ id: TURN, status: 'failed', error: { message: 'boom' }, items: [] }] } }, THREAD);
    expect(fromHistory!.itemIdentity).toEqual(failure.itemIdentity);
    const unknown = { type: 'futureTool', id: 'future-1' };
    expect(projector.projectNotifications(...lifecycle('item/started', unknown))).toEqual([]);
    const [completed] = projector.projectNotifications(...lifecycle('item/completed', unknown));
    expect(completed!.itemIdentity).toEqual({ key: 'error:unsupported-item:future-1', completes: true });
    expect(projectCodexThreadHistory({ thread: { id: THREAD, turns: [{ id: TURN, items: [unknown] }] } }, THREAD)[0]!.itemIdentity).toEqual(completed!.itemIdentity);
  });

  it('does not project the deprecated compaction notice, which repeats the compaction item', () => {
    const projector = new CodexEventProjector(THREAD);
    expect(projector.projectNotifications('thread/compacted', { threadId: THREAD, turnId: TURN })).toEqual([]);
  });

  it('does not turn the read position of a thread into an error', () => {
    expect(new CodexEventProjector(THREAD).projectNotifications('thread/readState/changed', { threadId: THREAD, readState: {} })).toEqual([]);
  });

  it('shows the plan of a plan-mode turn like any assistant text, as history lists it', () => {
    const plan = { type: 'plan', id: 'turn-1-plan', text: '- one\n- two\n', startedAtMs: 20 };
    const intro = { type: 'agentMessage', id: 'message-1', text: 'Here is the plan.\n\nBye', startedAtMs: 10 };
    const projector = new CodexEventProjector(THREAD);
    const stream = [
      ...projector.projectNotifications('item/started', { threadId: THREAD, turnId: TURN, item: { ...intro, text: '' } }),
      ...projector.projectNotifications(...delta('item/agentMessage/delta', 'message-1', 'Here is the plan.\n\n')),
      ...projector.projectNotifications('item/started', { threadId: THREAD, turnId: TURN, item: { ...plan, text: '' } }),
      ...projector.projectNotifications(...delta('item/plan/delta', 'turn-1-plan', '- one\n')),
      ...projector.projectNotifications(...delta('item/plan/delta', 'turn-1-plan', '- two\n')),
      ...projector.projectNotifications(...delta('item/agentMessage/delta', 'message-1', 'Bye')),
      ...projector.projectNotifications(...lifecycle('item/completed', plan)),
      ...projector.projectNotifications(...lifecycle('item/completed', intro)),
    ];
    expect(keys(stream)).toEqual(['assistant:message-1', 'assistant:turn-1-plan']);
    // Native history lists the plan first, because it finished first; it is read in the order the stream showed them.
    expect(keys(reread([plan, intro]))).toEqual(keys(stream));
    expect(timeline(stream).filter(({ itemIdentity }) => itemIdentity?.key === 'assistant:turn-1-plan').map(row => (body(row) as { text: string }).text).join('')).toBe(plan.text);
  });

  it('reads history in the order items started when their lifetimes overlap, and in native order when a start time is missing', () => {
    const early = { type: 'agentMessage', id: 'early', text: 'a', startedAtMs: 1 };
    const late = { type: 'plan', id: 'late', text: 'b', startedAtMs: 5 };
    expect(keys(reread([late, early]))).toEqual(['assistant:early', 'assistant:late']);
    expect(keys(reread([late, { ...early, startedAtMs: undefined }]))).toEqual(['assistant:late', 'assistant:early']);
  });

  it('ends what a turn left open when it ends: streamed text and reasoning with an empty body, a compaction as failed, a tool as it was', () => {
    const projector = new CodexEventProjector(THREAD);
    const opened = [
      ...projector.projectNotifications(...delta('item/agentMessage/delta', 'message-1', 'Half of ')),
      ...projector.projectNotifications(...delta('item/reasoning/summaryTextDelta', 'reasoning-1', 'Thinking', { summaryIndex: 0 })),
      ...projector.projectNotifications(...lifecycle('item/started', compaction)),
      ...projector.projectNotifications(...lifecycle('item/started', inProgress(command))),
    ];
    expect(opened.every(({ itemIdentity }) => itemIdentity?.completes !== true)).toBe(true);
    const ended = projector.projectNotifications('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } });
    expect(ended.map(({ event }) => event.type)).toEqual(['timeline', 'timeline', 'timeline', 'turn_canceled']);
    expect(ended.slice(0, 3).map(row => [row.itemIdentity?.key, row.itemIdentity?.completes, row.itemIdentity?.liveOnly])).toEqual([
      ['assistant:message-1', true, undefined], ['reasoning:reasoning-1', true, undefined], ['compaction:compaction-1', true, undefined],
    ]);
    expect((body(ended[2]!) as { status: string }).status).toBe('failed');
    expect(projector.projectNotifications('turn/completed', { threadId: THREAD, turn: { id: 'turn-2', status: 'completed' } }).map(({ event }) => event.type)).toEqual(['turn_completed']);
  });

  it('keeps the text of an item the history read says is still streaming, and forgets the ones it says are complete', () => {
    const projector = new CodexEventProjector(THREAD);
    const open = { type: 'agentMessage', id: 'open', text: 'par', completedAtMs: null };
    const done = { type: 'agentMessage', id: 'done', text: 'all', completedAtMs: 5 };
    projector.seedHistoryItem(open); projector.seedHistoryItem(done);
    projector.forgetCompleted(new Map<string, unknown>([['open', open], ['done', done]]));
    const ended = projector.projectNotifications('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } });
    expect(ended.filter(({ event }) => event.type === 'timeline').map(({ itemIdentity }) => itemIdentity?.key)).toEqual(['assistant:open']);
  });
});
