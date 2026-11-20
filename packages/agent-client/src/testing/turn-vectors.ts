import type { AgentStatus, BackgroundActivity, ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { Turn } from '../presentation/turns.js';
import { TimelineRows } from './timeline-kinds.js';

/**
 * The turn fold's vector table (I3 plan, section 4.1, rules T-1 to T-7), read by `turns.test.ts` and by the timeline's
 * component test. Each row is a short timeline and the turns it folds into, written with the entries' item keys:
 * a step is `key:kind:state` (its first entry's key), a group lists its other keys after `+`.
 */
export interface TurnVector {
  readonly rule: 'T-2' | 'T-3' | 'T-4' | 'T-5' | 'T-6' | 'T-7' | 'key';
  readonly name: string;
  readonly entries: readonly ProjectedTimelineEntry[];
  readonly activeTurn?: { readonly turnId: string } | null;
  readonly status?: AgentStatus;
  readonly pending?: number;
  readonly turns: readonly TurnShape[];
}

export interface TurnShape {
  readonly key?: string;
  readonly prompt?: string;
  readonly work: readonly string[];
  readonly answer: readonly string[];
  readonly letters?: readonly string[];
  readonly state: 'running' | 'ended';
}

/** A fold in the table's notation, for comparison with a row's `turns`. */
export function turnShapes(turns: readonly Turn[], withKeys = false): TurnShape[] {
  const key = (entry: ProjectedTimelineEntry) => entry.itemKey ?? '?';
  return turns.map(turn => ({
    ...(withKeys ? { key: turn.key } : {}),
    ...(turn.prompt ? { prompt: key(turn.prompt) } : {}),
    work: turn.work.map(step => `${step.key}:${step.kind}:${step.state}${step.entries.length > 1 ? `+${step.entries.slice(1).map(key).join('+')}` : ''}`),
    answer: turn.answer.map(key),
    ...(turn.letters.length ? { letters: turn.letters.map(key) } : {}),
    state: turn.state,
  }));
}

function rows(write: (rows: TimelineRows) => void): ProjectedTimelineEntry[] {
  const timeline = new TimelineRows();
  write(timeline);
  return timeline.entries;
}

const check = (status: BackgroundActivity['status']): BackgroundActivity => ({ id: `check-${status}`, kind: 'review', status });
const shell = { type: 'shell', command: 'npm test' } as const;
const t1 = { turnId: 't1' }, t2 = { turnId: 't2' };

export const TURN_VECTORS: readonly TurnVector[] = [
  { rule: 'T-2', name: "a person's message opens a turn", entries: rows(r => { r.user('Hi', { key: 'u1', ...t1 }); r.assistant('Hello', { key: 'a1', ...t1 }); r.user('Again', { key: 'u2', ...t2 }); r.assistant('Sure', { key: 'a2', ...t2 }); }),
    turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }, { prompt: 'u2', work: [], answer: ['a2'], state: 'ended' }] },
  { rule: 'T-2', name: "a background check's message stays in its step", entries: rows(r => {
    r.user('Hi', { key: 'u1', ...t1 }); r.assistant('Hello', { key: 'a1', ...t1 });
    r.user('Check it', { key: 'bu', background: check('silent') }); r.reasoning('Checking', { key: 'br', background: check('silent') }); r.assistant('Fine', { key: 'ba', background: check('silent') });
  }), turns: [{ prompt: 'u1', work: ['bu:background:done+br+ba'], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-3', name: 'remarks before a step are narration, the messages after the last step the answer', entries: rows(r => {
    r.user('Fix it', { key: 'u1' }); r.assistant('Let me look.', { key: 'n1' }); r.tool('Bash', shell, 'completed', { key: 'c1' }); r.assistant('Fixed.', { key: 'a1' }); r.assistant('Anything else?', { key: 'a2' });
  }), turns: [{ prompt: 'u1', work: ['n1:narration:done', 'c1:command:done'], answer: ['a1', 'a2'], state: 'ended' }] },
  { rule: 'T-3', name: 'a turn without steps is all answer', entries: rows(r => { r.user('Hi', { key: 'u1' }); r.assistant('Hello', { key: 'a1' }); r.assistant('How can I help?', { key: 'a2' }); }),
    turns: [{ prompt: 'u1', work: [], answer: ['a1', 'a2'], state: 'ended' }] },
  { rule: 'T-3', name: 'a turn that ends in a step has no answer', entries: rows(r => { r.user('Run it', { key: 'u1' }); r.assistant('Running.', { key: 'n1' }); r.tool('Bash', shell, 'failed', { key: 'c1' }); }),
    turns: [{ prompt: 'u1', work: ['n1:narration:done', 'c1:command:failed'], answer: [], state: 'ended' }] },
  { rule: 'T-3', name: 'a background check after the answer leaves the answer in place', entries: rows(r => {
    r.user('Fix it', { key: 'u1' }); r.tool('Bash', shell, 'completed', { key: 'c1' }); r.assistant('Fixed.', { key: 'a1' });
    r.user('Check', { key: 'bu', background: check('pending') }); r.reasoning('Checking', { key: 'br', background: check('pending') });
  }), turns: [{ prompt: 'u1', work: ['c1:command:done', 'bu:background:done+br'], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-3', name: "a failed check's own steps do not move the split either", entries: rows(r => {
    r.user('Fix it', { key: 'u1' }); r.tool('Bash', shell, 'completed', { key: 'c1' }); r.assistant('Fixed.', { key: 'a1' });
    r.user('Check', { key: 'bu', background: check('failed') }); r.tool('Bash', shell, 'failed', { key: 'bc', background: check('failed') });
  }), turns: [{ prompt: 'u1', work: ['c1:command:done', 'bu:background:done', 'bc:command:failed'], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-3', name: "a visible check's reply is an answer bubble", entries: rows(r => {
    r.user('Fix it', { key: 'u1' }); r.assistant('Fixed.', { key: 'a1' });
    r.user('Check', { key: 'bu', background: check('visible') }); r.assistant('One typo left.', { key: 'ba', background: check('visible') });
  }), turns: [{ prompt: 'u1', work: ['bu:background:done'], answer: ['a1', 'ba'], state: 'ended' }] },
  { rule: 'T-4', name: 'consecutive notices are one step', entries: rows(r => { r.user('Go', { key: 'u1' }); r.error('First', { key: 'e1' }); r.error('Second', { key: 'e2' }); r.assistant('Recovered.', { key: 'a1' }); }),
    turns: [{ prompt: 'u1', work: ['e1:notice:failed+e2'], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-4', name: 'a letter between two notices separates them and stays in the conversation', entries: rows(r => { r.user('Go', { key: 'u1' }); r.error('First', { key: 'e1' }); r.letter('Note', { key: 'l1' }); r.error('Second', { key: 'e2' }); }),
    turns: [{ prompt: 'u1', work: ['e1:notice:failed', 'e2:notice:failed'], answer: [], letters: ['l1'], state: 'ended' }] },
  { rule: 'T-4', name: 'checks in a row are one background step', entries: rows(r => {
    r.user('Go', { key: 'u1' }); r.assistant('Done.', { key: 'a1' });
    r.user('Check one', { key: 'b1', background: { ...check('silent'), id: 'one' } }); r.user('Check two', { key: 'b2', background: { ...check('silent'), id: 'two' } });
  }), turns: [{ prompt: 'u1', work: ['b1:background:done+b2'], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-5', name: 'a step runs, fails or is done with its tool call, compaction or notice', entries: rows(r => {
    r.user('Go', { key: 'u1' });
    r.tool('Bash', shell, 'running', { key: 'run' }); r.tool('Bash', shell, 'failed', { key: 'fail' }); r.tool('Bash', shell, 'canceled', { key: 'cancel' });
    r.compaction('loading', { key: 'cl' }); r.compaction('failed', { key: 'cf' }); r.compaction('completed', { key: 'cc' }); r.error('Broken', { key: 'e1' });
    r.reasoning('Hmm', { key: 'r1' }); r.todo([{ text: 'One', completed: false }], { key: 'd1' });
  }), turns: [{ prompt: 'u1', work: ['run:command:running', 'fail:command:failed', 'cancel:command:done', 'cl:compaction:running', 'cf:compaction:failed',
    'cc:compaction:done', 'e1:notice:failed', 'r1:reasoning:done', 'd1:todo:done'], answer: [], state: 'ended' }] },
  { rule: 'T-5', name: 'each tool kind is its own step kind', entries: rows(r => {
    r.user('Go', { key: 'u1' });
    r.tool('Read', { type: 'read', filePath: '/a.md' }, 'completed', { key: 'rd' }); r.tool('Edit', { type: 'edit', filePath: '/a.md' }, 'completed', { key: 'ed' });
    r.tool('Write', { type: 'write', filePath: '/b.md' }, 'completed', { key: 'wr' }); r.tool('Grep', { type: 'search', query: 'x' }, 'completed', { key: 'se' });
    r.tool('Fetch', { type: 'fetch', url: 'https://example.com' }, 'completed', { key: 'fe' }); r.tool('Task', { type: 'other', description: 'Delegate' }, 'completed', { key: 'ot' });
  }), turns: [{ prompt: 'u1', work: ['rd:read:done', 'ed:edit:done', 'wr:edit:done', 'se:search:done', 'fe:fetch:done', 'ot:tool:done'], answer: [], state: 'ended' }] },
  { rule: 'T-6', name: 'only the last turn runs while the active turn is its own', activeTurn: { turnId: 't2' }, status: 'running', entries: rows(r => {
    r.user('One', { key: 'u1', ...t1 }); r.assistant('Done', { key: 'a1', ...t1 }); r.user('Two', { key: 'u2', ...t2 }); r.tool('Bash', shell, 'running', { key: 'c2', ...t2 });
  }), turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }, { prompt: 'u2', work: ['c2:command:running'], answer: [], state: 'running' }] },
  { rule: 'T-6', name: 'an earlier turn never runs, even when the active turn names it', activeTurn: { turnId: 't1' }, status: 'running', entries: rows(r => {
    r.user('One', { key: 'u1', ...t1 }); r.assistant('Done', { key: 'a1', ...t1 }); r.user('Two', { key: 'u2', ...t2 }); r.assistant('Done too', { key: 'a2', ...t2 });
  }), turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }, { prompt: 'u2', work: [], answer: ['a2'], state: 'ended' }] },
  { rule: 'T-6', name: 'a request waiting for the person runs the last turn', activeTurn: null, status: 'waiting', pending: 1, entries: rows(r => {
    r.user('Write it', { key: 'u1', ...t1 }); r.assistant('May I?', { key: 'a1', ...t1 });
  }), turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'running' }] },
  { rule: 'T-6', name: 'rows without a turn run while the agent runs', activeTurn: null, status: 'running', entries: rows(r => { r.user('Go', { key: 'u1' }); r.tool('Bash', shell, 'running', { key: 'c1' }); }),
    turns: [{ prompt: 'u1', work: ['c1:command:running'], answer: [], state: 'running' }] },
  { rule: 'T-6', name: 'rows without a turn are ended while the agent is idle', activeTurn: null, status: 'idle', entries: rows(r => { r.user('Go', { key: 'u1' }); r.assistant('Done', { key: 'a1' }); }),
    turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-6', name: 'a turn the replica has not read yet leaves the last loaded one ended', activeTurn: { turnId: 't9' }, status: 'running', entries: rows(r => {
    r.user('One', { key: 'u1', ...t1 }); r.assistant('Done', { key: 'a1', ...t1 });
  }), turns: [{ prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }] },
  { rule: 'T-7', name: 'rows before the first message of the window are a turn without a prompt', entries: rows(r => {
    r.tool('Bash', shell, 'completed', { key: 'c0', ...t1 }); r.assistant('Earlier answer', { key: 'a0', ...t1 }); r.user('Next', { key: 'u2', ...t2 }); r.assistant('Sure', { key: 'a2', ...t2 });
  }), turns: [{ work: ['c0:command:done'], answer: ['a0'], state: 'ended' }, { prompt: 'u2', work: [], answer: ['a2'], state: 'ended' }] },
  { rule: 'key', name: "a turn is keyed by its id, a second turn of the same id and a turn without one by its first entry", entries: rows(r => {
    r.user('One', { key: 'u1', ...t1 }); r.assistant('Working on it', { key: 'a1', ...t1 }); r.user('Also this', { key: 'u2', ...t1 }); r.assistant('Both done', { key: 'a2', ...t1 });
    r.user('No id', { key: 'u3' }); r.assistant('Fine', { key: 'a3' });
  }), turns: [{ key: 't1', prompt: 'u1', work: [], answer: ['a1'], state: 'ended' }, { key: 'pos:u2', prompt: 'u2', work: [], answer: ['a2'], state: 'ended' },
    { key: 'pos:u3', prompt: 'u3', work: [], answer: ['a3'], state: 'ended' }] },
];
