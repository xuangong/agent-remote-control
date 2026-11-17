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
 * and drops what the stream never shows: the user row a finished sub-agent wakes the session with.
 * Returns `messages` itself when nothing changes.
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
  let changed = after.size > 0;
  const result = messages.flatMap((message): SessionMessage[] => {
    const row = byUuid.get(message.uuid);
    if (row && record(row.origin) && row.origin.kind === 'task-notification') { changed = true; return []; }
    const withResult = message.type === 'user' && row?.toolUseResult !== undefined ? { ...message, tool_use_result: row.toolUseResult } as ClaudeTranscriptMessage : message;
    if (withResult !== message) changed = true;
    return [withResult, ...(after.get(message.uuid) ?? [])];
  });
  return changed ? result : messages;
}

const isConversation = (row: Row | undefined): boolean => row !== undefined && (row.type === 'user' || row.type === 'assistant') && row.isSidechain !== true;

/** The text of folded input, or its content blocks when it carries an image. */
function foldedContent(prompt: unknown): string | unknown[] | undefined {
  if (typeof prompt === 'string') return prompt.trim() ? prompt : undefined;
  return Array.isArray(prompt) && prompt.some(block => record(block) && (block.type === 'image' || typeof block.text === 'string' && block.text.trim())) ? prompt : undefined;
}
