import type { JournalCatalog, JournalChanges, JournalItem, JournalMeta, JournalState, JournalStore } from '@orchardworks/agent-remote-journal';

export type SqlValue = string | number | null | Uint8Array;

/**
 * The synchronous SQLite surface the store needs. Node's `node:sqlite` and a Durable Object's storage both provide it.
 * A binary column reads back as a `Uint8Array`.
 */
export interface JournalSqlDatabase {
  run(sql: string, ...params: SqlValue[]): void;
  all<Row extends Record<string, SqlValue>>(sql: string, ...params: SqlValue[]): Row[];
  /** Runs `work` in one transaction: it commits when `work` returns and rolls back when it throws. Transactions do not nest. */
  transaction<T>(work: () => T): T;
}

/** The size at which a stored value is split: the convention of the Cloudflare state storage, and below a Durable Object's value limit. */
export const JOURNAL_CHUNK_BYTES = 256 * 1024;
const SCHEMA_VERSION = 1;
const META_PART = 'm';
const itemPart = (itemKey: string) => `i:${itemKey}`;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function splitValue(value: unknown, chunkBytes: number): Uint8Array[] {
  const bytes = encoder.encode(JSON.stringify(value));
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += chunkBytes) chunks.push(bytes.subarray(at, at + chunkBytes));
  return chunks;
}

function joinChunks(chunks: readonly Uint8Array[]): unknown {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  return JSON.parse(decoder.decode(bytes));
}

const TABLES = ['journal_chunks', 'journal_items', 'journal_sessions'] as const;

/** The key range of a prefix: every key from the prefix up to, not including, the prefix with its last character raised. */
function prefixRange(prefix: string): { where: string; params: string[] } {
  if (prefix === '') return { where: '1 = 1', params: [] };
  const end = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
  return { where: 'session_key >= ? AND session_key < ?', params: [prefix, end] };
}

/**
 * Stores journals in three tables: one row per session, one per item (its place in the sequence), and the chunks that
 * hold the JSON of the session's meta and of each item. A change is applied in one transaction.
 */
export class SqlJournalStore implements JournalStore {
  private readonly chunkBytes: number;

  readonly catalog: JournalCatalog = {
    list: async prefix => {
      const { where, params } = prefixRange(prefix);
      return this.db.all<{ session_key: string; has_head: number; bytes: number }>(
        `SELECT session_key, has_head, bytes FROM journal_sessions WHERE ${where} ORDER BY session_key`, ...params)
        .map(row => ({ sessionKey: row.session_key, hasHead: row.has_head === 1, bytes: row.bytes }));
    },
    deletePrefix: async prefix => {
      const { where, params } = prefixRange(prefix);
      this.db.transaction(() => {
        for (const table of TABLES) this.db.run(`DELETE FROM ${table} WHERE ${where}`, ...params);
      });
    },
  };

  constructor(private readonly db: JournalSqlDatabase, options: { chunkBytes?: number } = {}) {
    this.chunkBytes = options.chunkBytes ?? JOURNAL_CHUNK_BYTES;
    if (!Number.isInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > JOURNAL_CHUNK_BYTES) {
      throw new RangeError(`The journal chunk size must be an integer from 1 to ${JOURNAL_CHUNK_BYTES}.`);
    }
    db.transaction(() => {
      db.run('CREATE TABLE IF NOT EXISTS journal_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)');
      db.run(`CREATE TABLE IF NOT EXISTS journal_sessions (
        session_key TEXT PRIMARY KEY, has_head INTEGER NOT NULL, bytes INTEGER NOT NULL, meta_chunks INTEGER NOT NULL)`);
      db.run(`CREATE TABLE IF NOT EXISTS journal_items (
        session_key TEXT NOT NULL, item_key TEXT NOT NULL, seq_start INTEGER NOT NULL, chunks INTEGER NOT NULL,
        PRIMARY KEY (session_key, item_key)) WITHOUT ROWID`);
      db.run('CREATE INDEX IF NOT EXISTS journal_items_order ON journal_items (session_key, seq_start)');
      db.run(`CREATE TABLE IF NOT EXISTS journal_chunks (
        session_key TEXT NOT NULL, part TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        bytes BLOB NOT NULL CHECK (typeof(bytes) = 'blob' AND length(bytes) BETWEEN 1 AND ${JOURNAL_CHUNK_BYTES}),
        PRIMARY KEY (session_key, part, ordinal))`);
      const [schema] = db.all<{ version: number }>('SELECT version FROM journal_schema WHERE id = 1');
      if (!schema) db.run('INSERT INTO journal_schema (id, version) VALUES (1, ?)', SCHEMA_VERSION);
      else if (schema.version !== SCHEMA_VERSION) {
        throw new Error(`The journal database has schema version ${String(schema.version)}; this build reads version ${String(SCHEMA_VERSION)}.`);
      }
    });
  }

  async load(sessionKey: string): Promise<JournalState | undefined> {
    const [session] = this.db.all<{ meta_chunks: number }>('SELECT meta_chunks FROM journal_sessions WHERE session_key = ?', sessionKey);
    if (!session) return undefined;
    const parts = new Map<string, Uint8Array[]>();
    for (const chunk of this.db.all<{ part: string; bytes: Uint8Array }>('SELECT part, bytes FROM journal_chunks WHERE session_key = ? ORDER BY part, ordinal', sessionKey)) {
      const list = parts.get(chunk.part);
      if (list) list.push(chunk.bytes);
      else parts.set(chunk.part, [chunk.bytes]);
    }
    const meta = parts.get(META_PART);
    if (!meta) throw new Error(`The stored journal of ${sessionKey} has no meta.`);
    const items = this.db.all<{ item_key: string }>('SELECT item_key FROM journal_items WHERE session_key = ? ORDER BY seq_start', sessionKey).map(({ item_key }) => {
      const chunks = parts.get(itemPart(item_key));
      if (!chunks) throw new Error(`The stored journal of ${sessionKey} has no record of item ${item_key}.`);
      return joinChunks(chunks) as JournalItem;
    });
    return { meta: joinChunks(meta) as JournalMeta, items };
  }

  async apply(changes: JournalChanges): Promise<void> {
    const sessionKey = changes.meta.sessionKey;
    this.db.transaction(() => {
      if (changes.replaced) {
        this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part <> ?', sessionKey, META_PART);
        this.db.run('DELETE FROM journal_items WHERE session_key = ?', sessionKey);
      }
      for (const itemKey of changes.removed) {
        this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part = ?', sessionKey, itemPart(itemKey));
        this.db.run('DELETE FROM journal_items WHERE session_key = ? AND item_key = ?', sessionKey, itemKey);
      }
      const meta = splitValue(changes.meta, this.chunkBytes);
      this.writeChunks(sessionKey, META_PART, meta);
      this.db.run(`INSERT INTO journal_sessions (session_key, has_head, bytes, meta_chunks) VALUES (?, ?, ?, ?)
        ON CONFLICT (session_key) DO UPDATE SET has_head = excluded.has_head, bytes = excluded.bytes, meta_chunks = excluded.meta_chunks`,
      sessionKey, changes.meta.head === undefined ? 0 : 1, Math.round(changes.bytes), meta.length);
      for (const item of changes.upsert) {
        const chunks = splitValue(item, this.chunkBytes);
        this.writeChunks(sessionKey, itemPart(item.itemKey), chunks);
        this.db.run(`INSERT INTO journal_items (session_key, item_key, seq_start, chunks) VALUES (?, ?, ?, ?)
          ON CONFLICT (session_key, item_key) DO UPDATE SET seq_start = excluded.seq_start, chunks = excluded.chunks`,
        sessionKey, item.itemKey, item.seqStart, chunks.length);
      }
    });
  }

  async delete(sessionKey: string): Promise<void> {
    this.db.transaction(() => {
      for (const table of TABLES) this.db.run(`DELETE FROM ${table} WHERE session_key = ?`, sessionKey);
    });
  }

  private writeChunks(sessionKey: string, part: string, chunks: readonly Uint8Array[]): void {
    this.db.run('DELETE FROM journal_chunks WHERE session_key = ? AND part = ?', sessionKey, part);
    chunks.forEach((bytes, ordinal) => this.db.run('INSERT INTO journal_chunks (session_key, part, ordinal, bytes) VALUES (?, ?, ?, ?)', sessionKey, part, ordinal, bytes));
  }
}
