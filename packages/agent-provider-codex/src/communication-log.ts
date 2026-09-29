import { open } from 'node:fs/promises';
import { isRecord, readString } from './native.js';

export interface CommunicationRecord {
  id: string; sender: string; recipient: string; text: string; turnId: string; time: number; position: number;
}
export interface CommunicationHistoryBase {
  threadId: string; endOrdinalExclusive: number; endByteOffset: number;
}
export interface CommunicationLog {
  path: string; inode: number; device: number; size: number; modified: number; offset: number; lines: number;
  verified: boolean; agentPath?: string; parentId?: string; incomplete: boolean;
  messages: Map<string, CommunicationRecord>;
  anchors: Map<string, { position: number; time: number; turnId: string }>;
  turns: Map<string, number>;
  historyBase?: CommunicationHistoryBase;
  lastOrdinal?: number;
  latestTime: number;
}
const MAX_LINE_BYTES = 16 * 1024 * 1024;

/** Only complete local records are evidence. Never parse terminal output or encrypted envelopes. */
export async function readCommunicationLog(filePath: string, threadId: string, previous?: CommunicationLog,
  boundary?: CommunicationHistoryBase): Promise<CommunicationLog> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Communication history is not a regular file');
    const limit = boundary?.endByteOffset ?? stat.size;
    if (limit > stat.size) throw new Error('Communication history prefix is unavailable');
    const reusable = previous?.path === filePath && previous.inode === stat.ino && previous.device === stat.dev
      && stat.size >= previous.size && (stat.size > previous.size || stat.mtimeMs === previous.modified);
    if (reusable && stat.size === previous.size) return previous;
    const log: CommunicationLog = reusable ? previous : {
      path: filePath, inode: stat.ino, device: stat.dev, size: 0, modified: 0, offset: 0, lines: 0,
      verified: false, incomplete: false, messages: new Map(), anchors: new Map(), turns: new Map(), latestTime: -Infinity,
    };
    let position = log.offset;
    let pending = Buffer.alloc(0);
    let oversized = false;
    const buffer = Buffer.alloc(64 * 1024);
    while (position < limit) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limit - position), position);
      if (!bytesRead) break;
      let start = 0;
      for (let end = buffer.indexOf(10, start); end >= 0 && end < bytesRead; end = buffer.indexOf(10, start)) {
        const part = buffer.subarray(start, end);
        if (!oversized && pending.length + part.length <= MAX_LINE_BYTES) {
          consume(log, Buffer.concat([pending, part]).toString('utf8'), threadId, boundary);
        } else { log.incomplete = true; log.lines++; }
        pending = Buffer.alloc(0); oversized = false;
        log.offset = position + end + 1;
        start = end + 1;
      }
      const tail = buffer.subarray(start, bytesRead);
      if (!oversized && pending.length + tail.length <= MAX_LINE_BYTES) pending = Buffer.concat([pending, tail]);
      else { pending = Buffer.alloc(0); oversized = true; }
      position += bytesRead;
    }
    if (!log.verified) throw new Error('Communication history identity is unavailable');
    if (boundary && (log.offset !== limit || log.lastOrdinal !== boundary.endOrdinalExclusive - 1)) {
      throw new Error('Communication history prefix boundary is invalid');
    }
    log.size = stat.size; log.modified = stat.mtimeMs;
    return log;
  } finally { await file.close(); }
}

function consume(log: CommunicationLog, line: string, threadId: string, end?: CommunicationHistoryBase): void {
  const position = log.lines++;
  let row: unknown;
  try { row = JSON.parse(line); } catch { log.incomplete = true; return; }
  if (!isRecord(row) || !isRecord(row.payload)) { log.incomplete = true; return; }
  const item = row.payload;
  const ordinal = row.ordinal ?? (position + (log.historyBase?.endOrdinalExclusive ?? 0));
  if (end && (!Number.isSafeInteger(ordinal) || (ordinal as number) < 0 || (ordinal as number) >= end.endOrdinalExclusive
    || log.lastOrdinal !== undefined && (ordinal as number) <= log.lastOrdinal)) {
    throw new Error('Communication history ordinal is invalid');
  }
  log.lastOrdinal = ordinal as number;
  if (position === 0) {
    if (row.type !== 'session_meta' || item.id !== threadId) throw new Error('Communication history session mismatch');
    log.verified = true;
    log.agentPath = readString(item.agent_path);
    log.parentId = readString(item.parent_thread_id);
    if (item.history_base !== undefined && item.history_base !== null) {
      const base = item.history_base;
      if (isRecord(base) && readString(base.thread_id)
        && Number.isSafeInteger(base.end_ordinal_exclusive) && (base.end_ordinal_exclusive as number) > 0
        && Number.isSafeInteger(base.end_byte_offset) && (base.end_byte_offset as number) > 0) {
        log.historyBase = { threadId: base.thread_id as string, endOrdinalExclusive: base.end_ordinal_exclusive as number,
          endByteOffset: base.end_byte_offset as number };
      } else log.incomplete = true;
    }
    return;
  }
  if (!log.verified) return;
  const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  if (!Number.isFinite(time)) return;
  log.latestTime = Math.max(log.latestTime, time);
  const turnId = readString(item.turn_id);
  if (turnId && (row.type === 'turn_context' || row.type === 'event_msg' && item.type === 'task_started')) rememberTurn(log, turnId, time);
  if (row.type === 'event_msg' && item.type === 'item_completed' && item.thread_id === threadId && turnId && isRecord(item.item)) {
    const id = readString(item.item.id);
    if (id && !log.anchors.has(`item:${id}:completed`)) log.anchors.set(`item:${id}:completed`, { position, time, turnId });
    rememberTurn(log, turnId, time);
    return;
  }
  if (row.type !== 'response_item' || item.type !== 'agent_message') return;
  const id = readString(item.id), sender = readString(item.author), recipient = readString(item.recipient);
  const metadata = isRecord(item.internal_chat_message_metadata_passthrough) ? item.internal_chat_message_metadata_passthrough : {};
  const messageTurnId = readString(metadata.turn_id);
  if (!id || !sender || !recipient || !messageTurnId || !Array.isArray(item.content) || !item.content.length) {
    log.incomplete = true; return;
  }
  if (log.messages.has(id)) return;
  const encrypted = item.content.some(part => isRecord(part) && part.type === 'encrypted_content');
  if (!encrypted && !item.content.every(part => isRecord(part) && part.type === 'input_text' && typeof part.text === 'string')) {
    log.incomplete = true; return;
  }
  const text = encrypted ? '[Encrypted agent communication: plaintext unavailable]'
    : item.content.map(part => (part as { text: string }).text).join('\n');
  log.messages.set(id, { id, sender, recipient, text, turnId: messageTurnId, time, position });
  rememberTurn(log, messageTurnId, time);
}

function rememberTurn(log: CommunicationLog, id: string, time: number): void {
  log.turns.set(id, Math.min(time, log.turns.get(id) ?? Infinity));
}
