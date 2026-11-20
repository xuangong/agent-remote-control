/**
 * The files a loaded conversation changed or shared, derived only from its timeline entries: the file changes a tool call
 * reports, the resources and images a person attached. One row per path, newest first.
 *
 * - The newest mention of a path wins, so a file added and later deleted is one row that says deleted.
 * - Deleted files stay, with their kind; a rename is keyed by its new path.
 * - Failed and canceled tool calls changed nothing and are not listed.
 * - A tool call that names an edited or written file but reports no file changes still lists the file.
 */
import { isAgentFileChangesResult, type AgentFileChange, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { timelineEntryKey } from '../replica/timeline-entry-key.js';

export interface SessionFile {
  readonly path: string;
  readonly change?: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly source: 'change' | 'resource' | 'image';
  /** The timeline key of the entry that last mentioned the file. */
  readonly entryKey: string;
  readonly additions?: number;
  readonly deletions?: number;
}

/** Added and deleted lines of a unified diff, not counting the file headers before its first hunk. */
function countLines(diff: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0, inHunk = false;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('@@')) inHunk = true;
    else if (line.startsWith('+') && (inHunk || !line.startsWith('+++ '))) additions += 1;
    else if (line.startsWith('-') && (inHunk || !line.startsWith('--- '))) deletions += 1;
  }
  return { additions, deletions };
}

function changedFile(file: AgentFileChange, entryKey: string): SessionFile {
  return { path: file.path, ...(file.kind === 'unknown' ? {} : { change: file.kind }), source: 'change', entryKey, ...countLines(file.diff) };
}

function filesOf(entry: ProjectedTimelineEntry): SessionFile[] {
  const { item } = entry;
  const entryKey = timelineEntryKey(entry);
  if (item.type === 'user_message') {
    return (item.content ?? []).flatMap((part): SessionFile[] => part.type === 'resource' ? [{ path: part.name, source: 'resource', entryKey }]
      : part.type === 'image' ? [{ path: part.label, source: 'image', entryKey }] : []);
  }
  if (item.type !== 'tool_call' || item.status === 'failed' || item.status === 'canceled') return [];
  const reported = item.result?.content.flatMap(block => block.type === 'json' && isAgentFileChangesResult(block.value) ? block.value.files : []) ?? [];
  if (reported.length) return reported.map(file => changedFile(file, entryKey));
  if (item.detail.type === 'edit') return [{ path: item.detail.filePath, change: 'modified', source: 'change', entryKey }];
  if (item.detail.type === 'write') return [{ path: item.detail.filePath, source: 'change', entryKey }];
  return [];
}

/** One row per path, the newest mention winning, newest first. `entries` are in timeline order. */
export function sessionFiles(entries: readonly ProjectedTimelineEntry[]): readonly SessionFile[] {
  const byPath = new Map<string, SessionFile>();
  for (const entry of entries) {
    for (const file of filesOf(entry)) {
      byPath.delete(file.path);
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()].reverse();
}
