import { createHmac } from 'node:crypto';
import { pruneRelayDiagnostics, type GatewayAuthOptions, type RelayDiagnostic, type RelayDiagnosticStore } from '@orchardworks/agent-remote-hosted';

const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_CHUNKS = MAX_SNAPSHOT_BYTES / CHUNK_BYTES;
type SnapshotChunk = { id: number; version: number; scope: string; total: number; value: string };

/** A bounded snapshot in a separate table keeps diagnostic corruption out of business state. */
export class SqliteDiagnosticStore implements RelayDiagnosticStore {
  readonly initial: RelayDiagnostic[];
  private readonly scope: string;
  constructor(private readonly storage: DurableObjectStorage, auth: GatewayAuthOptions) {
    this.scope = createHmac('sha256', auth.secret).update(JSON.stringify(['arc-diagnostics', 1, auth.origin, auth.issuer])).digest('hex');
    let initial: RelayDiagnostic[] = [];
    try {
      this.ensureTable();
      const rows = storage.sql.exec<SnapshotChunk>(
        'SELECT id, version, scope, total, value FROM relay_connection_diagnostics WHERE length(value) <= ? ORDER BY id LIMIT ?', CHUNK_BYTES, MAX_CHUNKS + 1).toArray();
      if (rows.length > 0 && rows.length <= MAX_CHUNKS && rows.every((row, index) => row.id === index + 1 && row.total === rows.length && row.version === 1 && row.scope === this.scope)) {
        initial = pruneRelayDiagnostics(JSON.parse(rows.map(row => row.value).join('')));
      }
    } catch { /* Missing or corrupt diagnostics cannot prevent Relay startup. */ }
    this.initial = initial;
  }
  async save(entries: RelayDiagnostic[]): Promise<void> {
    const value = JSON.stringify(pruneRelayDiagnostics(entries));
    if (new TextEncoder().encode(value).byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Diagnostic snapshot exceeds its size limit.');
    this.storage.transactionSync(() => {
      this.ensureTable();
      this.storage.sql.exec('DELETE FROM relay_connection_diagnostics');
      const total = Math.ceil(value.length / CHUNK_BYTES);
      for (let index = 0; index < total; index++) {
        this.storage.sql.exec('INSERT INTO relay_connection_diagnostics (id, version, scope, total, value) VALUES (?, 1, ?, ?, ?)', index + 1, this.scope, total, value.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
      }
    });
    await this.storage.sync();
  }
  private ensureTable() {
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_connection_diagnostics (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, scope TEXT NOT NULL, total INTEGER NOT NULL, value TEXT NOT NULL)');
  }
}
