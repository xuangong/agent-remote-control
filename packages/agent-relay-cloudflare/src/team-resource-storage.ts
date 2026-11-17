/** Chunk storage is separate from bounded Team message snapshots. */
export class SqliteTeamResourceStorage {
  constructor(private readonly storage: DurableObjectStorage, private readonly namespace: string) {
    if (!namespace || namespace.length > 512) throw new Error('Invalid resource storage namespace.');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS relay_team_resource_chunks (namespace TEXT NOT NULL, key TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY (namespace, key))');
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    this.checkKey(key);
    const row = this.storage.sql.exec<{ value: ArrayBuffer }>('SELECT value FROM relay_team_resource_chunks WHERE namespace = ? AND key = ?', this.namespace, key).toArray()[0];
    return row ? new Uint8Array(row.value) : undefined;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.checkKey(key);
    if (value.byteLength > 128 * 1024) throw new Error('Resource storage records must not exceed 128 KiB.');
    this.storage.sql.exec('INSERT INTO relay_team_resource_chunks (namespace, key, value) VALUES (?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value',
      this.namespace, key, new Uint8Array(value).buffer);
    await this.storage.sync();
  }

  async delete(key: string): Promise<void> {
    this.checkKey(key);
    this.storage.sql.exec('DELETE FROM relay_team_resource_chunks WHERE namespace = ? AND key = ?', this.namespace, key);
    await this.storage.sync();
  }

  async list(prefix: string): Promise<string[]> {
    if (prefix.length > 512) throw new Error('Resource key prefix is too long.');
    // Read keys only: listing manifests must not load file chunks into memory.
    return this.storage.sql.exec<{ key: string }>('SELECT key FROM relay_team_resource_chunks WHERE namespace = ? AND substr(key, 1, ?) = ? ORDER BY key',
      this.namespace, prefix.length, prefix).toArray().map(row => row.key);
  }

  private checkKey(key: string): void {
    if (!key || key.length > 512) throw new Error('Invalid resource storage key.');
  }
}
