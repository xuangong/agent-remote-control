import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import type { Translate } from './messages.js';
import type { Turn, WorkStep } from './turns.js';

/**
 * The words of a turn's work (I3 plan, section 4.2): the one-line summary of its steps ("Read 3 files, wrote notes.md,
 * ran 2 commands") and the live line of a running turn ("Chief is running tests", "2 of 5 done"). Pure; the words come
 * from the catalogue.
 *
 * Summary rules:
 * - One clause per kind of work, in the order the turn first did it; at most three, then "and N more".
 * - A single file is named by its file name; several are counted. Edits that only wrote new files say "wrote".
 * - Remarks between steps, runtime notices and answered interactions add no clause: notices count as failed steps, and
 *   answered interactions are their own lines in the conversation.
 * - Work with steps but no clause says how many steps it took; no steps at all is no line (empty text).
 */

export interface WorkSummary {
  readonly text: string;
  /** Steps that failed; the view says "N steps failed" beside the line. */
  readonly failed: number;
  readonly running: boolean;
}

type Clause = { readonly group: string; readonly words: (t: Translate) => string };

/** The last segment of a path: what a person calls the file. */
export function fileName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

function toolItem(entry: ProjectedTimelineEntry | undefined) {
  return entry?.item.type === 'tool_call' ? entry.item : undefined;
}
function stepPath(step: WorkStep): string | undefined {
  const detail = toolItem(step.entries[0])?.detail;
  return detail && 'filePath' in detail ? detail.filePath : undefined;
}

function clauses(steps: readonly WorkStep[]): Clause[] {
  const order: string[] = [];
  const counted = new Map<string, WorkStep[]>();
  for (const step of steps) {
    const group = step.kind === 'narration' || step.kind === 'notice' || step.kind === 'interaction_receipt' ? undefined : step.kind;
    if (!group) continue;
    if (!counted.has(group)) { order.push(group); counted.set(group, []); }
    counted.get(group)!.push(step);
  }
  return order.map(group => {
    const members = counted.get(group)!;
    const paths = [...new Set(members.flatMap(step => stepPath(step) ?? []))];
    const count = members.length;
    switch (group) {
      case 'read': return { group, words: t => paths.length === 1 ? t('work.readFile', { file: fileName(paths[0]!) }) : t('work.readFiles', { count: paths.length || count }) };
      case 'edit': {
        const wrote = members.every(step => toolItem(step.entries[0])?.detail.type === 'write');
        return { group, words: t => paths.length === 1 ? t(wrote ? 'work.writeFile' : 'work.editFile', { file: fileName(paths[0]!) })
          : t(wrote ? 'work.writeFiles' : 'work.editFiles', { count: paths.length || count }) };
      }
      case 'command': return { group, words: t => t('work.commands', { count }) };
      case 'search': return { group, words: t => t('work.searches', { count }) };
      case 'fetch': return { group, words: t => t('work.fetches', { count }) };
      case 'tool': return { group, words: t => t('work.tools', { count }) };
      case 'reasoning': return { group, words: t => t('work.reasoning') };
      case 'todo': return { group, words: t => t('work.todo') };
      case 'compaction': return { group, words: t => t('work.compaction') };
      default: {
        const checks = new Set(members.flatMap(step => step.entries.flatMap(entry => entry.item.background ? [entry.item.background.id] : []))).size;
        return { group, words: t => t('work.background', { count: checks || count }) };
      }
    }
  });
}

/** The one-line summary of a turn's steps. */
export function workSummary(steps: readonly WorkStep[], t: Translate): WorkSummary {
  const failed = steps.filter(step => step.state === 'failed').length;
  const running = steps.some(step => step.state === 'running');
  const work = steps.filter(step => step.kind !== 'interaction_receipt');
  if (!work.length) return { text: '', failed, running };
  const all = clauses(work);
  const shown = all.slice(0, 3).map(clause => clause.words(t));
  if (all.length > 3) shown.push(t('work.more', { count: all.length - 3 }));
  const text = shown.length ? shown.join(t('work.separator')) : t('work.steps', { count: work.length });
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, running };
}

const TEST_COMMAND = /(^|[\s/:;&|(])(test|tests|jest|vitest|pytest|mocha|rspec|phpunit|playwright test)(?=$|[\s:;&|)])/i;

/** The live line of a running turn: what the assistant is doing now, and the progress of its latest todo. */
export function liveStatus(name: string, turn: Turn, t: Translate): { readonly sentence: string; readonly progress?: string } {
  const todo = [...turn.work].reverse().find(step => step.kind === 'todo')?.entries.at(-1)?.item;
  const tasks = todo?.type === 'todo' ? todo.items : [];
  const done = tasks.filter(task => task.status ? task.status === 'completed' : task.completed).length;
  const progress = tasks.length ? t('status.progress', { done, total: tasks.length }) : undefined;
  return { sentence: liveSentence(name, turn, t), ...(progress ? { progress } : {}) };
}

function liveSentence(name: string, turn: Turn, t: Translate): string {
  const running = [...turn.work].reverse().find(step => step.state === 'running');
  if (running) {
    const tool = toolItem(running.entries.at(-1));
    const file = stepPath(running);
    switch (running.kind) {
      case 'command': return t(tool?.detail.type === 'shell' && TEST_COMMAND.test(tool.detail.command) ? 'status.tests' : 'status.command', { name });
      case 'read': return file ? t('status.reading', { name, file: fileName(file) }) : t('status.working', { name });
      case 'edit': return file ? t(tool?.detail.type === 'write' ? 'status.writing' : 'status.editing', { name, file: fileName(file) }) : t('status.working', { name });
      case 'search': return t('status.searching', { name });
      case 'fetch': return t('status.fetching', { name });
      case 'tool': return t('status.tool', { name, tool: tool ? tool.name.split('__').at(-1) || tool.name : '' });
      case 'compaction': return t('status.compacting', { name });
      case 'background': return t('status.background', { name });
      default: return t('status.working', { name });
    }
  }
  if (turn.answer.length) return t('status.replying', { name });
  switch (turn.work.at(-1)?.kind) {
    case 'reasoning': return t('status.thinking', { name });
    case 'todo': return t('status.planning', { name });
    default: return t('status.working', { name });
  }
}
