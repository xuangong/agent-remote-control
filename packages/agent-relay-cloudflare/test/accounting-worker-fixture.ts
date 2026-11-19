import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { workspaceSourceEsbuild } from '../../../scripts/lib/workspace-source.mjs';
import { Miniflare } from 'miniflare';

import { accountingAuth } from './accounting-fixture-object.js';
export { accountingAuth };
/** An isolated state/store boundary; this test object has no Host or native-effect supplier. */
export async function accountingWorker() {
  const directory = await mkdtemp(join(tmpdir(), 'arc-accounting-worker-'));
  const result = await build({ stdin: { contents: `
    export { AccountingFixture } from './test/accounting-fixture-object.ts';
    export default { fetch(request, env) { return env.STATE.get(env.STATE.idFromName('isolated')).fetch(request); } };
  `, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'import'],
    external: ['node:*', 'cloudflare:*'], plugins: [workspaceSourceEsbuild()] });
  let mf: Miniflare;
  async function start() {
    mf = new Miniflare({ modules: true, script: result.outputFiles[0]!.text, compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { STATE: { className: 'AccountingFixture', useSQLite: true } }, durableObjectsPersist: join(directory, 'state') });
    await mf.ready;
  }
  try { await start(); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const request = (path: string, body?: object) => mf.dispatchFetch(accountingAuth.origin + path, { signal: AbortSignal.timeout(5000), ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) } as any);
  return { directory, request, async json(path: string) { return await (await request(path)).json() as any; },
    async restart(afterDispose?: () => Promise<void>) { await mf.dispose(); await afterDispose?.(); await start(); },
    async close(afterDispose?: () => Promise<void>) { await mf.dispose(); try { await afterDispose?.(); } finally { await rm(directory, { recursive: true, force: true }); } } };
}
