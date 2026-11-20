import { mergeBackgroundActivity, type AgentStatus, type BackgroundActivity, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';

/**
 * Turns: the unit the conversation folds by (I3 plan, decision 1 and section 4.1). A turn is a person's message and
 * everything after it up to their next message. Its answer is the run of assistant messages after its last work step;
 * everything before (reasoning, tool calls, todos, compaction, runtime notices, answered interactions, background checks
 * and the assistant's remarks between steps) is its work. Letters stay beside the conversation. Pure: it reads replica
 * entries and the agent's active turn only.
 *
 * Rules (vectors in `@orchardworks/agent-client/testing`, `TURN_VECTORS`):
 * - T-1. Every entry appears in exactly one turn, once, in order.
 * - T-2. A person's message opens a turn; a background check's message does not (it stays in its background step).
 * - T-3. Assistant messages after the last step are the answer; assistant messages before a step are narration steps.
 *   Background activity never moves the split: a check that ran after the answer leaves the answer where it was.
 * - T-4. Consecutive runtime notices are one `notice` step; consecutive rows of a background check are one `background` step.
 * - T-5. A step is running while its tool call or compaction runs, failed when its tool call or compaction failed or it
 *   is a runtime notice, otherwise done.
 * - T-6. Only the last turn can run: it runs while a request waits for the person, while the agent's active turn is one of
 *   its turns, or, when its rows carry no turn, while the agent is running.
 * - T-7. Rows before the first message of the loaded window are a turn of their own, without a prompt.
 */

export type WorkStepKind = 'reasoning' | 'command' | 'read' | 'edit' | 'search' | 'fetch' | 'tool' | 'todo' | 'compaction' | 'notice' | 'narration' | 'background' | 'interaction_receipt';
export type WorkStepState = 'running' | 'done' | 'failed';

export interface WorkStep {
  /** The key of the step's first entry. */
  readonly key: string;
  readonly kind: WorkStepKind;
  readonly state: WorkStepState;
  /** One entry, or the entries of a notice group or a background check, in order. */
  readonly entries: readonly ProjectedTimelineEntry[];
}

export interface Turn {
  /** The turn's id where its rows carry one and no earlier turn took it, otherwise `pos:<first entry key>`. */
  readonly key: string;
  readonly turnId?: string;
  /** The person's message; absent for rows before the first message of the loaded window. */
  readonly prompt?: ProjectedTimelineEntry;
  readonly work: readonly WorkStep[];
  readonly answer: readonly ProjectedTimelineEntry[];
  /** Letters between agents, which stay in the conversation. */
  readonly letters: readonly ProjectedTimelineEntry[];
  readonly state: 'running' | 'ended';
}

type Unit =
  | { readonly type: 'message'; readonly entry: ProjectedTimelineEntry }
  | { readonly type: 'step'; readonly kind: WorkStepKind; readonly entries: ProjectedTimelineEntry[]; readonly background: boolean };

/** Folds a loaded timeline into turns. `pendingInteractions` counts the requests waiting for the person. */
export function foldTurns(entries: readonly ProjectedTimelineEntry[], activeTurn: { readonly turnId: string } | null, agentStatus?: AgentStatus, pendingInteractions = 0): readonly Turn[] {
  const checks = backgroundStates(entries);
  const bodies: { prompt?: ProjectedTimelineEntry; rows: ProjectedTimelineEntry[] }[] = [];
  for (const entry of entries) {
    if (entry.item.type === 'user_message' && !entry.item.background) bodies.push({ prompt: entry, rows: [] });
    else if (bodies.length) bodies.at(-1)!.rows.push(entry);
    else bodies.push({ rows: [entry] });
  }
  const used = new Set<string>();
  return bodies.map((body, index) => {
    const turn = foldBody(body.rows, checks);
    const ids = new Set([body.prompt, ...body.rows].flatMap(entry => entry?.turnId ? [entry.turnId] : []));
    const last = index === bodies.length - 1;
    const running = last && (pendingInteractions > 0 || (activeTurn !== null && ids.has(activeTurn.turnId))
      || (ids.size === 0 && (agentStatus === 'running' || agentStatus === 'waiting')));
    const turnId = body.prompt?.turnId ?? [...ids][0];
    const first = (body.prompt ?? body.rows[0])!;
    const key = turnId !== undefined && !used.has(turnId) ? turnId : `pos:${timelineEntryKey(first)}`;
    used.add(key);
    return { key, ...(turnId !== undefined ? { turnId } : {}), ...(body.prompt ? { prompt: body.prompt } : {}), ...turn, state: running ? 'running' : 'ended' } satisfies Turn;
  });
}

function foldBody(rows: readonly ProjectedTimelineEntry[], checks: ReadonlyMap<string, BackgroundActivity>): Pick<Turn, 'work' | 'answer' | 'letters'> {
  const letters: ProjectedTimelineEntry[] = [];
  const units: Unit[] = [];
  rows.forEach((entry, index) => {
    const item = entry.item, previous = units.at(-1);
    // A group goes on only with the row right after its last one: a letter between two notices separates them.
    const joins = (kind: WorkStepKind) => previous?.type === 'step' && previous.kind === kind && previous.entries.at(-1) === rows[index - 1];
    if (item.type === 'agent_communication') letters.push(entry);
    else if (inBackgroundStep(entry, checks)) {
      if (joins('background')) (previous as Extract<Unit, { type: 'step' }>).entries.push(entry);
      else units.push({ type: 'step', kind: 'background', entries: [entry], background: true });
    } else if (item.type === 'error' && joins('notice')) (previous as Extract<Unit, { type: 'step' }>).entries.push(entry);
    else if (item.type === 'assistant_message') units.push({ type: 'message', entry });
    else units.push({ type: 'step', kind: stepKind(entry), entries: [entry], background: !!item.background });
  });
  // The split is the last step of the person's own turn; a background check after the answer leaves the answer in place.
  let split = -1;
  units.forEach((unit, index) => { if (unit.type === 'step' && !unit.background) split = index; });
  const work: WorkStep[] = [], answer: ProjectedTimelineEntry[] = [];
  units.forEach((unit, index) => {
    if (unit.type === 'message') {
      if (index > split) answer.push(unit.entry);
      else work.push({ key: timelineEntryKey(unit.entry), kind: 'narration', state: 'done', entries: [unit.entry] });
    } else work.push({ key: timelineEntryKey(unit.entries[0]!), kind: unit.kind, state: stepState(unit.kind, unit.entries), entries: unit.entries });
  });
  return { work, answer, letters };
}

/** Today's background grouping: a check's message always, its quiet work unless the check failed, and a silent check's reply. */
function inBackgroundStep(entry: ProjectedTimelineEntry, checks: ReadonlyMap<string, BackgroundActivity>): boolean {
  const item = entry.item, background = item.background;
  if (!background) return false;
  if (item.type === 'user_message') return true;
  const status = checks.get(background.id)?.status;
  if (status === 'failed') return false;
  return item.type === 'reasoning' || item.type === 'tool_call' && item.status !== 'failed' && item.status !== 'canceled'
    || status === 'silent' && item.type === 'assistant_message';
}

function backgroundStates(entries: readonly ProjectedTimelineEntry[]): ReadonlyMap<string, BackgroundActivity> {
  const states = new Map<string, BackgroundActivity>();
  for (const { item } of entries) if (item.background) states.set(item.background.id, mergeBackgroundActivity(states.get(item.background.id), item.background));
  return states;
}

function stepKind(entry: ProjectedTimelineEntry): WorkStepKind {
  const item = entry.item;
  switch (item.type) {
    case 'reasoning': return 'reasoning';
    case 'todo': return 'todo';
    case 'compaction': return 'compaction';
    case 'error': return 'notice';
    case 'interaction': return 'interaction_receipt';
    case 'tool_call': switch (item.detail.type) {
      case 'shell': return 'command';
      case 'read': return 'read';
      case 'edit': case 'write': return 'edit';
      case 'search': return 'search';
      case 'fetch': return 'fetch';
      case 'other': return 'tool';
    }
    // A person's message never reaches a body, and assistant messages and letters are not steps; a remark is the safe reading.
    default: return 'narration';
  }
}

function stepState(kind: WorkStepKind, entries: readonly ProjectedTimelineEntry[]): WorkStepState {
  if (kind === 'notice') return 'failed';
  let state: WorkStepState = 'done';
  for (const { item } of entries) {
    if (item.type === 'tool_call' && item.status === 'failed' || item.type === 'compaction' && item.status === 'failed') return 'failed';
    if (item.type === 'tool_call' && item.status === 'running' || item.type === 'compaction' && item.status === 'loading') state = 'running';
  }
  return state;
}
