import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SESSION_PREVIEW_LENGTH, SESSION_PREVIEW_MAX_LENGTH, SESSION_STATE_LIMIT, type ProjectedTimelineEntry, type TimelineCursor } from '@orchardworks/agent-remote-protocol';

/** What an open session offers for reading its latest reply: where its timeline is, and the timeline's tail. */
export interface ReplySource {
  timelineCursor(): TimelineCursor;
  fetchTimeline(request: { requestId: string; agentId: string; direction: 'tail'; limit: number }): { payload: { entries: readonly ProjectedTimelineEntry[] } };
}
export interface ReplySession { providerId: string; nativeSessionId: string }
/** When a session's latest reply was produced, and a short plain-text excerpt of it. */
export interface ReplyFacts { replyAt: number; preview: string }
export interface SessionReplies {
  /** Reads an open session's latest reply, when its timeline moved since the last reading. */
  observe(session: ReplySession, agentId: string, source: ReplySource): void;
  facts(session: ReplySession): ReplyFacts | undefined;
  /** Resolves once the remembered replies are on disk. */
  flush(): Promise<void>;
  /** Writes what is not yet on disk and stops. */
  close(): void;
}
export interface SessionRepliesOptions {
  /** Where replies are kept across restarts; without it they live in memory only. */
  file?: string;
  limit?: number;
  saveDelayMs?: number;
}

/** Entries read from a timeline's end to find its latest reply. */
const TAIL = 12;
const key = (session: ReplySession) => JSON.stringify([session.providerId, session.nativeSessionId]);

/** A reply as one line of plain text: Markdown marks, code blocks and link targets removed, cut to the preview length. */
export function replyPreview(text: string): string | undefined {
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(\*\*|\*|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/(?<!\w)(__|_)(?=\S)([^\n]*?\S)\1(?!\w)/g, '$2')
    .replace(/\s+/g, ' ').trim();
  if (!plain) return undefined;
  if (plain.length <= SESSION_PREVIEW_LENGTH) return plain;
  const cut = plain.slice(0, SESSION_PREVIEW_LENGTH - 1), space = cut.lastIndexOf(' ');
  return `${(space > SESSION_PREVIEW_LENGTH * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Each session's latest reply, read from the tails of the timelines this Controller holds open and remembered after a
 * session is released, so the Relay can show it without opening the session. Facts are derived from the sessions and
 * can be rebuilt from them; the most recent replies within the limit are kept.
 */
export function createSessionReplies(options: SessionRepliesOptions = {}): SessionReplies {
  const limit = options.limit ?? SESSION_STATE_LIMIT, saveDelayMs = options.saveDelayMs ?? 2_000, file = options.file;
  const replies = new Map<string, ReplyFacts>();
  /** The timeline position each session was last read at. */
  const read = new Map<string, string>();
  let dirty = false, closed = false, timer: ReturnType<typeof setTimeout> | undefined, saving = Promise.resolve();
  load();

  function load() {
    if (!file) return;
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; replies?: unknown };
      if (value?.version !== 1 || !Array.isArray(value.replies)) return;
      for (const row of value.replies.slice(-limit)) {
        if (!Array.isArray(row) || row.length !== 4) continue;
        const [providerId, nativeSessionId, replyAt, preview] = row as unknown[];
        if (typeof providerId !== 'string' || !providerId || providerId.length > 512 || typeof nativeSessionId !== 'string' || !nativeSessionId || nativeSessionId.length > 4096
          || !Number.isSafeInteger(replyAt) || (replyAt as number) < 0 || typeof preview !== 'string' || !preview || preview.length > SESSION_PREVIEW_MAX_LENGTH) continue;
        replies.set(key({ providerId, nativeSessionId }), { replyAt: replyAt as number, preview });
      }
    } catch { /* A missing or damaged file starts empty; replies come back as sessions reply. */ }
  }
  function encode() {
    return JSON.stringify({ version: 1, replies: [...replies].map(([id, facts]) => [...JSON.parse(id) as [string, string], facts.replyAt, facts.preview]) });
  }
  function save(): Promise<void> {
    saving = saving.then(async () => {
      if (!dirty || !file) return;
      dirty = false;
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, encode(), { mode: 0o600 });
        await rename(temporary, file);
      } catch { dirty = true; /* Kept in memory; the next reply writes again. */ }
    });
    return saving;
  }
  function schedule() {
    dirty = true;
    if (!file || closed || timer) return;
    timer = setTimeout(() => { timer = undefined; void save(); }, saveDelayMs);
    timer.unref?.();
  }
  function remember(id: string, facts: ReplyFacts) {
    const previous = replies.get(id);
    if (previous && (facts.replyAt < previous.replyAt || facts.replyAt === previous.replyAt && facts.preview === previous.preview)) return;
    replies.delete(id); replies.set(id, facts);
    if (replies.size > limit) {
      let oldest: [string, ReplyFacts] | undefined;
      for (const entry of replies) if (!oldest || entry[1].replyAt < oldest[1].replyAt) oldest = entry;
      if (oldest) replies.delete(oldest[0]);
    }
    schedule();
  }

  return {
    observe(session, agentId, source) {
      if (closed) return;
      const id = key(session);
      let position: string, entries: readonly ProjectedTimelineEntry[];
      try {
        const cursor = source.timelineCursor();
        position = `${cursor.epoch}:${cursor.seq}`;
        if (read.get(id) === position) return;
        entries = source.fetchTimeline({ requestId: 'session-replies', agentId, direction: 'tail', limit: TAIL }).payload.entries;
      } catch { return; }
      if (read.size >= 2 * limit) read.clear();
      read.set(id, position);
      for (let index = entries.length - 1; index >= 0; index--) {
        const item = entries[index]!.item;
        if (item.type !== 'assistant_message') continue;
        const preview = replyPreview(item.text), replyAt = Math.floor(Date.parse(entries[index]!.timestamp));
        if (!preview || !Number.isSafeInteger(replyAt) || replyAt < 0) continue;
        remember(id, { replyAt, preview });
        return;
      }
    },
    facts(session) {
      const facts = replies.get(key(session));
      return facts && { ...facts };
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      return save();
    },
    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (!dirty || !file) return;
      // Shutdown may not wait for a pending write, so the last replies are written at once.
      try {
        mkdirSync(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        writeFileSync(temporary, encode(), { mode: 0o600 });
        renameSync(temporary, file);
        dirty = false;
      } catch { /* The replies come back as sessions reply again. */ }
    },
  };
}
