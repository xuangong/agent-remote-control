import { readFile, realpath } from 'node:fs/promises';
import { forkSession } from '@anthropic-ai/claude-agent-sdk';
import type { AgentNativePrefixTarget } from '@orchardworks/agent-provider-sdk';
import { transcriptFile } from './folded-input.js';
import { record } from './projector.js';

/** The native boundary of a prompt edit: the conversation entry the new branch ends with, or none for the first prompt. */
export interface ClaudePromptEditBoundary { cwd: string; forkPoint: string | null }

interface Row {
  /** Conversation entries carry a parent link; metadata entries such as titles do not. */
  linked: boolean; uuid: string; parentUuid: string | null; logicalParentUuid?: string; type?: unknown; subtype?: unknown; sessionId?: unknown;
  isSidechain?: unknown; isMeta?: unknown; isCompactSummary?: unknown; isVisibleInTranscriptOnly?: unknown;
  cwd?: unknown; message?: unknown; attachment?: unknown;
}

const nativeRecord = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification)>/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readTranscript(sessionId: string, env: NodeJS.ProcessEnv = process.env): Promise<Row[] | undefined> {
  const file = await transcriptFile(sessionId, env);
  if (!file) return undefined;
  const rows: Row[] = [];
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value) || typeof value.uuid !== 'string') continue;
    rows.push({ ...value, linked: 'parentUuid' in value, uuid: value.uuid, parentUuid: typeof value.parentUuid === 'string' ? value.parentUuid : null,
      ...(typeof value.logicalParentUuid === 'string' ? { logicalParentUuid: value.logicalParentUuid } : {}) });
  }
  return rows;
}

/** The conversation the native runtime resumes: the newest main-thread entry and its ancestors, across compaction. */
export function activeChain(rows: readonly Row[]): Row[] {
  const byId = new Map(rows.map(row => [row.uuid, row]));
  const leaf = [...rows].reverse().find(row => row.linked && row.isSidechain !== true);
  const chain: Row[] = [];
  const seen = new Set<string>();
  for (let current = leaf; current && !seen.has(current.uuid); current = byId.get(current.parentUuid ?? current.logicalParentUuid ?? '')) {
    seen.add(current.uuid); chain.push(current);
  }
  return chain.reverse();
}

type PromptKind = 'prompt' | 'tool' | 'summary' | 'command' | 'steer' | 'other';
function classify(row: Row): PromptKind {
  if (row.type === 'attachment' && record(row.attachment) && row.attachment.type === 'queued_command') return 'steer';
  if (row.type === 'user' && row.isCompactSummary === true) return 'summary';
  if (row.type !== 'user' || row.isSidechain === true || row.isMeta === true || row.isVisibleInTranscriptOnly === true) return 'other';
  const content = record(row.message) ? row.message.content : undefined;
  if (typeof content === 'string') return !content.trim() ? 'other' : nativeRecord.test(content.trimStart()) ? 'command' : 'prompt';
  if (!Array.isArray(content) || !content.length || !content.every(record)) return 'other';
  if (content.some(block => block.type === 'tool_result')) return 'tool';
  if (content.some(block => block.type !== 'text' && block.type !== 'image')) return 'other';
  const text = content.filter(block => block.type === 'text').map(block => typeof block.text === 'string' ? block.text : '').join('');
  if (text.trimStart() && nativeRecord.test(text.trimStart())) return 'command';
  return text.trim() || content.some(block => block.type === 'image') ? 'prompt' : 'other';
}

/**
 * Each conversation entry belongs to the turn its nearest ancestor prompt started. Ancestors rather than
 * file order, because parallel tool calls branch into sibling entries; a compaction boundary ends a turn.
 */
export function promptTurns(rows: readonly Row[]): Map<string, string> {
  const byId = new Map(rows.map(row => [row.uuid, row]));
  const turns = new Map<string, string | null>();
  const turnOf = (start: Row): string | null => {
    const path = new Set<Row>();
    let turn: string | null = null;
    for (let row: Row | undefined = start; row; row = byId.get(row.parentUuid ?? '')) {
      const known = turns.get(row.uuid);
      if (known !== undefined) { turn = known; break; }
      if (path.has(row)) break;
      path.add(row);
      if (row.type === 'system' && row.subtype === 'compact_boundary') break;
      if (classify(row) === 'prompt') { turn = row.uuid; break; }
    }
    for (const row of path) turns.set(row.uuid, turn);
    return turn;
  };
  const result = new Map<string, string>();
  for (const row of rows) { if (!row.linked || row.isSidechain === true) continue; const turn = turnOf(row); if (turn) result.set(row.uuid, turn); }
  return result;
}

/** Codex semantics: only the prompt that started a turn is editable, and the branch keeps everything before it. */
export async function inspectPromptEdit(sessionId: string, target: AgentNativePrefixTarget, env: NodeJS.ProcessEnv = process.env): Promise<ClaudePromptEditBoundary> {
  if (target.nativeSessionId !== sessionId || !uuid.test(sessionId) || !uuid.test(target.messageId)) throw new Error('The selected Claude prompt identity is invalid.');
  if (target.turnId !== target.messageId) throw new Error('Only the first prompt of a turn can be edited. This message was sent while Claude was working.');
  const rows = await readTranscript(sessionId, env);
  if (!rows) throw new Error('The source conversation is unavailable.');
  const chain = activeChain(rows), index = chain.findIndex(row => row.uuid === target.messageId);
  const selected = index < 0 ? rows.find(row => row.uuid === target.messageId) : chain[index];
  if (!selected) throw new Error('This message is no longer available in the source conversation.');
  if (selected.isSidechain === true) throw new Error('Editing previous prompts is unavailable in native child conversations.');
  if (index < 0) throw new Error('This message is not part of the current conversation.');
  const kind = classify(selected);
  if (kind === 'steer') throw new Error('Only the first prompt of a turn can be edited. This message was sent while Claude was working.');
  if (kind === 'summary') throw new Error('The compaction summary is not a prompt. Edit a prompt before or after it.');
  if (kind === 'command') throw new Error('Native command records cannot be restored in the web composer. Edit a prompt you typed.');
  if (kind !== 'prompt') throw new Error('This message is not a prompt that can be edited.');
  if (typeof selected.cwd !== 'string' || !selected.cwd) throw new Error('The source conversation workspace is unavailable.');
  return { cwd: await realpath(selected.cwd), forkPoint: index ? chain[index - 1]!.uuid : null };
}

/** Creates the branch before the selected prompt; the first prompt has no prefix, so its branch starts empty. */
export async function forkPromptEdit(sessionId: string, target: AgentNativePrefixTarget, env: NodeJS.ProcessEnv = process.env): Promise<{ cwd: string; sessionId: string | null }> {
  const boundary = await inspectPromptEdit(sessionId, target, env);
  if (!boundary.forkPoint) return { cwd: boundary.cwd, sessionId: null };
  const { sessionId: branch } = await forkSession(sessionId, { dir: boundary.cwd, upToMessageId: boundary.forkPoint });
  if (!uuid.test(branch) || branch === sessionId) throw new Error('Claude did not create an independent prompt-edit branch.');
  return { cwd: boundary.cwd, sessionId: branch };
}

/** The native fork copies main-thread entries in file order through the fork point, remapping their identities. */
const conversation = (rows: readonly Row[]) => rows.filter(row => row.linked && row.isSidechain !== true && (row.type === 'user' || row.type === 'assistant'))
  .map(row => JSON.stringify([row.type, row.message ?? null]));

/** Branch content inspection compares the conversation only; runtime metadata may follow when the branch opens. */
export async function verifyPromptEditBranch(sessionId: string, target: AgentNativePrefixTarget, candidateId: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!uuid.test(candidateId) || candidateId === sessionId) throw new Error('Invalid Claude prompt-edit candidate identity.');
  const boundary = await inspectPromptEdit(sessionId, target, env);
  const candidate = await readTranscript(candidateId, env);
  if (!boundary.forkPoint) {
    if (candidate && conversation(candidate).length) throw new Error('Claude candidate is not an empty conversation.');
    return;
  }
  const source = await readTranscript(sessionId, env);
  if (!source || !candidate) throw new Error('Claude candidate conversation is unavailable.');
  const end = source.findIndex(row => row.uuid === boundary.forkPoint);
  const prefix = conversation(source.slice(0, end + 1));
  const actual = conversation(candidate);
  const workspace = activeChain(candidate).filter(row => typeof row.cwd === 'string').at(-1)?.cwd as string | undefined;
  if (candidate.some(row => row.sessionId !== undefined && row.sessionId !== candidateId) || !workspace
    || await realpath(workspace) !== boundary.cwd) throw new Error('Claude candidate identity or workspace does not match.');
  if (prefix.length !== actual.length || prefix.some((entry, index) => entry !== actual[index])) throw new Error('Claude candidate does not contain the exact native prompt-edit prefix.');
}
