import { isRecord, readString } from './native.js';

export interface CodexSessionSummary {
  nativeSessionId: string;
  providerId: 'codex';
  title: string;
  workspace?: string;
  createdAt: string;
  updatedAt: string;
  state: 'idle' | 'running' | 'waiting' | 'unknown' | 'unavailable';
}

export interface CodexSessionPage { sessions: CodexSessionSummary[]; nextCursor?: string }
export interface CodexSessionListOptions { cursor?: string; limit?: number }

export function readCodexSessionPage(value: unknown): CodexSessionPage {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new Error('Codex thread/list returned an invalid catalog.');
  const sessions: CodexSessionSummary[] = [];
  for (const row of value.data) {
    const summary = readCodexThreadSummary(row, 'thread/list');
    if (summary) sessions.push(summary);
  }
  if (value.nextCursor != null && typeof value.nextCursor !== 'string') throw new Error('Codex thread/list returned an invalid cursor.');
  return { sessions, ...(typeof value.nextCursor === 'string' && value.nextCursor ? { nextCursor: value.nextCursor } : {}) };
}

/** The catalog summary of one native thread; subagent threads belong to their parent and have none. */
export function readCodexThreadSummary(row: unknown, method: 'thread/list' | 'thread/read'): CodexSessionSummary | undefined {
  if (!isRecord(row) || typeof row.id !== 'string') throw new Error(`Codex ${method} returned an invalid thread.`);
  if (row.parentThreadId || (isRecord(row.source) && 'subAgent' in row.source)) return undefined;
  const status = isRecord(row.status) ? row.status : {};
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  // notLoaded is local to this app-server; an external owner may still be working.
  return {
    nativeSessionId: row.id, providerId: 'codex',
    title: readString(row.name)?.trim() || readString(row.preview)?.trim().slice(0, 160) || row.id,
    ...(readString(row.cwd) ? { workspace: readString(row.cwd) } : {}),
    createdAt: timestamp(row.createdAt, method), updatedAt: timestamp(row.updatedAt ?? row.createdAt, method),
    state: status.type === 'active' ? flags.some((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ? 'waiting' : 'running'
      : status.type === 'systemError' ? 'unavailable' : status.type === 'idle' ? 'idle' : 'unknown',
  };
}

function timestamp(value: unknown, method: 'thread/list' | 'thread/read'): string {
  const date = new Date(typeof value === 'number' ? value * 1000 : NaN);
  if (!Number.isFinite(date.getTime())) throw new Error(`Codex ${method} returned an invalid timestamp.`);
  return date.toISOString();
}
