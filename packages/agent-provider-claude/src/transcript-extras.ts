import type { SessionMessage } from '@anthropic-ai/claude-agent-sdk';
import { record } from './projector.js';
import type { Row } from './prompt-edit.js';

/** A conversation row as the public read returns it, with what only the transcript holds. */
export type ClaudeTranscriptMessage = SessionMessage & { tool_use_result?: unknown };

/**
 * The public session read leaves things out that the live stream carries or that the Timeline needs, so one pass over the raw transcript
 * rows restores them, in one place:
 * - the structured result of a tool (`toolUseResult`), which the live frame of the same uuid carries as `tool_use_result`, so a reread
 *   tool row equals the live one and keeps its file diffs;
 * - input folded into a running turn, a `queued_command` attachment, as a user row after the conversation entry it followed, with the
 *   uuid the Controller gave the input (`source_uuid`), which is the uuid its live row has;
 * and drops what the stream never shows: the user row a finished sub-agent wakes the session with, and the summary row a compaction writes.
 * Rows come in the order the transcript was written (see `inWrittenOrder`). Returns `messages` itself when nothing changes.
 */
export function withTranscriptExtras(sessionId: string, messages: SessionMessage[], rows: readonly Row[] | undefined): SessionMessage[] {
  if (!rows?.length) return messages;
  const byUuid = new Map(rows.map(row => [row.uuid, row]));
  const known = new Set(messages.map(message => message.uuid));
  const after = new Map<string, SessionMessage[]>();
  for (const row of rows) {
    if (row.type !== 'attachment' || row.isSidechain === true || !record(row.attachment) || row.attachment.type !== 'queued_command' || row.attachment.commandMode !== 'prompt') continue;
    const content = foldedContent(row.attachment.prompt);
    const uuid = typeof row.attachment.source_uuid === 'string' ? row.attachment.source_uuid : row.uuid;
    if (content === undefined || known.has(uuid)) continue;
    // Walk up through entries that public reads omit to the conversation entry this input followed.
    let anchor = row.parentUuid;
    const visited = new Set<string>();
    while (anchor && !known.has(anchor) && !visited.has(anchor) && !isConversation(byUuid.get(anchor))) { visited.add(anchor); anchor = byUuid.get(anchor)?.parentUuid ?? null; }
    // A conversation entry missing from the rows means a bounded read ended earlier; the position is outside it.
    if (!anchor || !known.has(anchor)) continue;
    const list = after.get(anchor) ?? [];
    list.push({ type: 'user', uuid, session_id: sessionId, parent_tool_use_id: null, parent_agent_id: null, message: { role: 'user', content } } as SessionMessage);
    after.set(anchor, list);
  }
  const ordered = inWrittenOrder(messages, rows);
  let changed = after.size > 0 || ordered !== messages;
  const result = ordered.flatMap((message): SessionMessage[] => {
    const row = byUuid.get(message.uuid);
    // What the stream never shows is dropped; input folded after it stays, attached where it was.
    if (row && (row.isCompactSummary === true || record(row.origin) && row.origin.kind === 'task-notification')) { changed = true; return after.get(message.uuid) ?? []; }
    const withResult = message.type === 'user' && row?.toolUseResult !== undefined ? { ...message, tool_use_result: row.toolUseResult } as ClaudeTranscriptMessage : message;
    if (withResult !== message) changed = true;
    return [withResult, ...(after.get(message.uuid) ?? [])];
  });
  return changed ? result : messages;
}

/**
 * The messages in the order their rows were written. Claude Code appends each row as it happens, so the file's line order is the order
 * the stream showed. The parent chain is not: a tool that finishes while later blocks of its message still stream gets its result written
 * between them, the next block links to that result, and the blocks before it leave the chain. The public read follows the chain and adds
 * what left it after the message's last chained row. Within one chain the two orders agree, as a row is written after its parent. A
 * message the transcript lacks stays after the message it followed.
 */
function inWrittenOrder(messages: SessionMessage[], rows: readonly Row[]): SessionMessage[] {
  const line = new Map<string, number>();
  rows.forEach((row, at) => { if (!line.has(row.uuid)) line.set(row.uuid, at); });
  let previous = -1;
  const positions = messages.map((message, at) => { previous = line.get(message.uuid) ?? previous; return { message, line: previous, at }; });
  if (positions.every((entry, at) => at === 0 || positions[at - 1]!.line <= entry.line)) return messages;
  return positions.sort((a, b) => a.line - b.line || a.at - b.at).map(entry => entry.message);
}

const isConversation = (row: Row | undefined): boolean => row !== undefined && (row.type === 'user' || row.type === 'assistant') && row.isSidechain !== true;

/** The text of folded input, or its content blocks when it carries an image. */
function foldedContent(prompt: unknown): string | unknown[] | undefined {
  if (typeof prompt === 'string') return prompt.trim() ? prompt : undefined;
  return Array.isArray(prompt) && prompt.some(block => record(block) && (block.type === 'image' || typeof block.text === 'string' && block.text.trim())) ? prompt : undefined;
}
