import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountingFixture, accountingAuth } from './accounting-fixture-object.js';
import { sqliteStorage } from './sqlite-storage.js';

/** The accounting fixture in this process over node:sqlite; `restart` opens it again over the same rows. `directory` is an empty scratch directory, as no file is kept. */
export function accountingInProcess() {
  const { storage } = sqliteStorage();
  let object = new AccountingFixture({ storage });
  const ready = mkdtemp(join(tmpdir(), 'arc-accounting-process-')).then(async path => { await mkdir(join(path, 'state')); return path; });
  const request = (path: string, body?: object) => object.fetch(new Request(accountingAuth.origin + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}));
  return ready.then(directory => ({ directory, request, async json(path: string) { return await (await request(path)).json() as any; },
    async restart(afterDispose?: () => Promise<void>) { await afterDispose?.(); object = new AccountingFixture({ storage }); },
    async close(afterDispose?: () => Promise<void>) { try { await afterDispose?.(); } finally { await rm(directory, { recursive: true, force: true }); } } }));
}
