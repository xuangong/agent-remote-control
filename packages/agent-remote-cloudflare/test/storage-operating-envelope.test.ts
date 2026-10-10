import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, access, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { release, platform, arch, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { gzipSync, gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { accountingWorker, accountingAuth as auth } from './accounting-worker-fixture.js';
import { finalizeOperatingSample } from './operating-sample-finalizer.js';
import { operatingCases, operatingEncoding, operatingWarmUpdate, prepareOperatingDatasets, stateDigest, type OperatingCase } from './storage-operating-fixture.js';
import { deriveSuccessionCapacity } from '../../agent-remote-hosted/src/succession-capacity.js';
import { validateRelayState, type HostedRelayState } from '../../agent-remote-hosted/src/state.js';
import { encodeSqlSnapshot } from '../src/storage-codec.js';

let output: string;
let ownedOutput: string | undefined;
let datasets: Record<OperatingCase, HostedRelayState>;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const identical = (actual: unknown, expected: unknown, message: string) => check(stateDigest(actual) === stateDigest(expected), message + ` (${stateDigest(actual)} / ${stateDigest(expected)})`);
const normalizeManifests = (rows: any[]) => rows.map(row => ({ format: row.format, kind: row.kind, identity: row.identity, byte_length: row.byte_length, chunk_count: row.chunk_count, digest: row.digest }))
  .sort((a, b) => (a.kind + a.identity).localeCompare(b.kind + b.identity));

beforeAll(async () => {
  const inputPath = process.env.TASK9E_INPUT_DIRECTORY, outputPath = process.env.TASK9E_OUTPUT_DIRECTORY;
  const measurement = inputPath !== undefined || outputPath !== undefined;
  let identities: Record<OperatingCase, string>;
  if (measurement) {
    check(Boolean(inputPath && outputPath), 'Measurement requires both TASK9E_INPUT_DIRECTORY and TASK9E_OUTPUT_DIRECTORY.');
    const input = resolve(inputPath!), manifest = JSON.parse(await readFile(join(input, 'execution-manifest.json'), 'utf8'));
    const bytes = await readFile(join(input, 'datasets.json.gz'));
    check(sha256(bytes) === manifest.datasetArtifact.sha256, 'Frozen dataset artifact hash changed.');
    datasets = JSON.parse(gunzipSync(bytes).toString());
    identities = Object.fromEntries(manifest.cases.map((row: any) => [row.id, row.snapshotSha256])) as Record<OperatingCase, string>;
    output = resolve(outputPath!); await mkdir(output, { recursive: true });
  } else {
    const prepared = prepareOperatingDatasets(); datasets = prepared.datasets;
    identities = Object.fromEntries(prepared.summaries.map(row => [row.id, row.snapshotSha256])) as Record<OperatingCase, string>;
    output = ownedOutput = await mkdtemp(join(tmpdir(), 'arc-storage-operating-'));
  }
  for (const id of operatingCases) {
    validateRelayState(datasets[id], auth);
    check(deriveSuccessionCapacity(datasets[id], operatingEncoding).violations.length === 0, id + ' validation failed.');
    check(stateDigest(datasets[id]) === identities[id], id + ' dataset identity changed.');
  }
  const withoutOrdinary: any = structuredClone(datasets.O); delete withoutOrdinary.operatingOrdinaryExtra;
  identical(withoutOrdinary, datasets.L, 'O changed an L feature identity or obligation.');
  await writeFile(join(output, 'environment.json'), JSON.stringify({ node: process.version, versions: process.versions, os: { platform: platform(), release: release(), arch: arch() },
    miniflare: JSON.parse(await readFile('node_modules/miniflare/package.json', 'utf8')).version,
    workerd: JSON.parse(await readFile(createRequire(await realpath('node_modules/miniflare/package.json')).resolve('workerd/package.json'), 'utf8')).version,
    compatibilityDate: '2026-06-01', compatibilityFlags: ['nodejs_compat'],
    transport: 'Miniflare dispatchFetch and Worker SQLite; deterministic fake RelaySocket Host peer',
    clock: 'Node performance.now monotonic milliseconds; Worker performance.now call durations can have coarse/frozen execution-turn resolution',
    units: { time: 'milliseconds', memory: 'bytes', cpu: 'microseconds', files: 'apparent bytes' },
    unmeasured: ['isolate heap/CPU', 'owned workerd RSS/CPU', 'exact peaks', 'block/page/index usage', 'pure store encoding time', 'uninstrumented instrumentation overhead baseline'] }, null, 2) + '\n');
}, 30000);

afterAll(async () => {
  if (ownedOutput) await rm(ownedOutput, { recursive: true, force: true });
}, 30000);

async function files(directory: string, point: string) {
  const rows: any[] = [];
  async function visit(path: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) { const info = await stat(absolute); rows.push({ path: absolute.slice(directory.length + 1), apparentBytes: info.size,
        role: /-wal$/.test(entry.name) ? 'WAL' : /-shm$/.test(entry.name) ? 'SHM' : /\.sqlite$/.test(entry.name) ? 'SQLite' : 'auxiliary' }); }
    }
  }
  await visit(join(directory, 'state'));
  return { point, fileCount: rows.length, apparentBytes: rows.reduce((sum, row) => sum + row.apparentBytes, 0), files: rows.sort((a, b) => a.path.localeCompare(b.path)) };
}

function resource() { return { memory: process.memoryUsage(), cpu: process.cpuUsage() }; }
async function timed<T>(sample: any, name: string, operation: () => Promise<T>): Promise<T> {
  const before = resource(), start = performance.now();
  try { const result = await operation(); sample.phases.push({ name, milliseconds: performance.now() - start, success: true, before, after: resource() }); return result; }
  catch (error) { sample.phases.push({ name, milliseconds: performance.now() - start, success: false, error: String(error), before, after: resource() }); throw error; }
}
async function response(f: Awaited<ReturnType<typeof accountingWorker>>, path: string, body?: object) {
  const reply = await f.request(path, body); return { path, status: reply.status, body: await reply.text() };
}

function validatePhysical(snapshot: HostedRelayState, physical: any, cache?: any[]) {
  const encoded = encodeSqlSnapshot(validateRelayState(snapshot, auth), auth);
  const expected = normalizeManifests([...encoded.records.values()].map(record => record.manifest));
  identical(normalizeManifests(physical.manifests), expected, 'Physical manifest identity mismatch.');
  const chunks = [...encoded.records.values()].flatMap(record => record.chunks.map(chunk => ({ kind: chunk.kind, identity: chunk.identity, ordinal: chunk.ordinal,
    byteLength: chunk.bytes.byteLength, bytes: sha256(new Uint8Array(chunk.bytes as Uint8Array)) }))).sort((a, b) => (a.kind + a.identity).localeCompare(b.kind + b.identity) || a.ordinal - b.ordinal);
  identical(physical.chunks.map((row: any) => ({ kind: row.kind, identity: row.identity, ordinal: row.ordinal, byteLength: row.byteLength, bytes: row.bytes })), chunks, 'Complete chunk length/digest/order mismatch.');
  check(physical.metadata.length === 1 && physical.metadata[0].version === 3, 'SQL metadata format mismatch.');
  if (cache) identical(normalizeManifests(cache), expected, 'SQL store record cache mismatch.');
  return { snapshotSha256: stateDigest(snapshot), capacity: deriveSuccessionCapacity(snapshot, operatingEncoding),
    recordCount: expected.length, chunkCount: chunks.length, blobBytes: chunks.reduce((sum, row) => sum + row.byteLength, 0),
    chunkMinimumBytes: Math.min(...chunks.map(row => row.byteLength)), chunkMaximumBytes: Math.max(...chunks.map(row => row.byteLength)),
    manifestJsonBytes: operatingEncoding.measureSnapshot(snapshot).costs.reduce((sum, row) => sum + row.manifestBytes, 0) };
}

async function inspect(sample: any, f: Awaited<ReturnType<typeof accountingWorker>>, point: string, sameCurrent = true) {
  const start = performance.now(), status = await f.json('/status'), physical = await f.json('/physical'), operating = await f.json('/operating/status'), restored = await f.json('/restore');
  if (sameCurrent) identical(restored, status.current, point + ' restored/current mismatch.');
  const summary = validatePhysical(restored, physical, sameCurrent ? operating.cache : undefined);
  const file = `${sample.id}-${point}.json.gz`, raw = gzipSync(JSON.stringify({ status, physical, operating, restored }));
  await writeFile(join(output, file), raw);
  sample.inspections.push({ point, milliseconds: performance.now() - start, file, sha256: sha256(raw), bytes: raw.byteLength, ...summary,
    publications: status.publications, failures: status.failures, observed: operating.observed, cache: operating.cache });
  return { status, physical, operating, restored };
}

function statementDelta(before: any, after: any) {
  const result: any = {};
  for (const [key, value] of Object.entries(after.observed)) {
    if (typeof value === 'number') result[key] = value - before.observed[key];
  }
  result.statements = after.observed.statements.slice(before.observed.statements.length);
  result.transactions = after.observed.transactions.slice(before.observed.transactions.length);
  result.statementAttempts = result.statements.length;
  result.statementSuccesses = result.statements.filter((row: any) => row.succeeded).length;
  return result;
}
function changedRows(before: any, after: any) {
  const key = (row: any) => JSON.stringify([row.kind, row.identity]), previous = new Map(before.manifests.map((row: any) => [key(row), row]));
  const next = new Map(after.manifests.map((row: any) => [key(row), row]));
  return { inserted: [...next.keys()].filter(key => !previous.has(key)), deleted: [...previous.keys()].filter(key => !next.has(key)),
    changed: [...next.keys()].filter(key => previous.has(key) && stateDigest(previous.get(key)) !== stateDigest(next.get(key))) };
}

async function nominalLarge(sample: any, f: Awaited<ReturnType<typeof accountingWorker>>) {
  await response(f, '/retention/open'); const connection = await timed(sample, 'warmConnect', () => response(f, '/retention/connect')); check(connection.status === 200, 'Warm connection failed.');
  sample.responses.push(connection);
  await inspect(sample, f, 'before-consumers'); const peerBefore = await f.json('/retention/status');
  sample.peerBefore = peerBefore;
  const chainBefore = await f.json('/operating/status');
  const start = performance.now();
  for (const action of ['terminal', 'favorites', 'rotation', 'acknowledgment']) {
    const reply = await timed(sample, 'warm-' + action, () => response(f, '/retention/' + action)); sample.responses.push(reply);
    check(reply.status < 400, action + ' refused: ' + reply.body);
  }
  sample.warmAdmittedChainMilliseconds = performance.now() - start;
  const chainAfter = await f.json('/operating/status');
  sample.warmDelta = statementDelta(chainBefore, chainAfter);
  check(sample.warmDelta.statements.every((row: any) => row.phase === 'commit') && sample.warmDelta.transactions.every((row: any) => row.owner === 'commit'), 'Admitted chain included an inspection or restore owner.');
  const admitted = await inspect(sample, f, 'admitted'), peerAdmitted = await f.json('/retention/status');
  const first = admitted.status.current.tenants[0];
  check(first.broker.associations.freezes[0].released === 'committed', 'Terminal did not consume first-tenant freeze.');
  check(first.favoritesSuccession.receipts[0].status === 'applied', 'Favorites did not consume first-tenant progress.');
  check(admitted.status.current.sessionStars.find((row: any) => row.subject === 'owner').nativeSessionId === 'B', 'Favorites did not move owner source A to B.');
  check(peerAdmitted.counts.issued === peerBefore.counts.issued + 1 && peerAdmitted.counts.registered === peerBefore.counts.registered + 1, 'Recovery credential rotation/acknowledgment did not complete.');
  const observationBefore = await f.json('/operating/status');
  const refused = await timed(sample, 'warm-refused-admission', () => response(f, '/retention/admission')); sample.responses.push(refused);
  const observationAfter = await f.json('/operating/status'), peerAfter = await f.json('/retention/status'), statusAfter = await f.json('/status');
  const error = JSON.parse(refused.body); expect(refused.status).toBe(409); expect(error.code).toBe('succession_projection_capacity_exceeded');
  sample.refusal = { response: refused, delta: statementDelta(observationBefore, observationAfter), peerBefore: peerAdmitted, peerAfter };
  check(sample.refusal.delta.measureCalls > 0 && sample.refusal.delta.quoteCalls > 0, 'Refusal did not enter sole final encoding/capacity policy.');
  for (const counter of ['commitEntries', 'transactionEntries', 'syncEntries', 'statementAttempts']) check(sample.refusal.delta[counter] === 0, 'Refused admission entered ' + counter);
  identical(peerAfter, peerAdmitted, 'Refusal advanced Broker/effects/replies.'); identical(statusAfter.current, admitted.status.current, 'Refusal advanced current.');
  check(statusAfter.publications === admitted.status.publications, 'Refusal advanced publication.');
}

async function faultLarge(sample: any, f: Awaited<ReturnType<typeof accountingWorker>>, fault: string) {
  check((await response(f, '/retention/open')).status === 200, 'Fault peer open failed.');
  check((await response(f, '/retention/connect')).status === 200, 'Fault peer connection failed.');
  const before = await inspect(sample, f, 'before-fault'), peerBefore = await f.json('/retention/status');
  sample.peerBefore = peerBefore;
  if (fault === 'late-progress') await response(f, '/operating/late-progress?on=1');
  else await response(f, '/retention/arm?mode=' + fault);
  const observationsBefore = await f.json('/operating/status');
  let replied = false;
  const pending = timed(sample, 'fault-' + fault, async () => {
    const reply = await response(f, '/retention/terminal'); replied = true; return reply;
  });
  if (fault === 'hold') {
    const deadline = performance.now() + 3000;
    let held;
    do { held = await f.json('/status'); check(performance.now() < deadline, 'Held post-sync gate exceeded 3s polling deadline.'); } while (!held.entered);
    check(!replied, 'Held terminal replied before gate release.');
    const physicalHeld = await inspect(sample, f, 'held', false), peerHeld = await f.json('/retention/status');
    identical(physicalHeld.status.current, before.status.current, 'Held gate advanced current.');
    identical(physicalHeld.operating.cache, before.operating.cache, 'Held gate advanced store cache.');
    identical(peerHeld.broker, peerBefore.broker, 'Held gate advanced Broker.');
    check(physicalHeld.status.publications === before.status.publications, 'Held gate advanced publication.');
    for (const counter of ['releases', 'issued', 'registered', 'creates']) check(peerHeld.counts[counter] === peerBefore.counts[counter], 'Held gate advanced ' + counter);
    check(physicalHeld.restored.tenants[0].broker.associations.freezes[0].released === 'committed', 'Actual synced SQL lacks held complete terminal.');
    const heldObservation = await f.json('/operating/status'), heldDelta = statementDelta(observationsBefore, heldObservation);
    const restoreTransactions = heldDelta.transactions.filter((row: any) => row.owner === 'restore');
    check(restoreTransactions.length === 1 && restoreTransactions[0].succeeded, 'Held readback lacked its actual restore transaction owner.');
    check(heldDelta.transactions.filter((row: any) => row.owner === 'commit').length === 1, 'Held terminal lost its actual commit transaction owner.');
    check(heldDelta.statements.some((row: any) => row.phase === 'restore') && heldDelta.statements.some((row: any) => row.phase === 'commit'), 'Held interval did not distinguish interleaved restore statements.');
    sample.held = { replied, peer: peerHeld, exposedSnapshotSha256: stateDigest(physicalHeld.restored), delta: heldDelta };
    await response(f, '/release');
  }
  const reply = await pending; sample.responses.push(reply);
  const observationsAfter = await f.json('/operating/status');
  if (fault === 'hold') check(reply.status === 200, 'Released gate did not finish terminal.');
  else check(reply.status === 503, 'Injected fault did not expose failed terminal.');
  const after = await inspect(sample, f, 'after-fault', fault !== 'reject'), peerAfter = await f.json('/retention/status');
  sample.fault = { mode: fault, delta: statementDelta(observationsBefore, observationsAfter), reply, peerAfter,
    durability: fault === 'reject' ? 'unknown durability; complete exposed snapshot only' : fault === 'hold' ? 'post-real-sync gate released' : 'actual transaction rolled back' };
  if (fault !== 'hold') {
    identical(after.status.current, before.status.current, 'Failed terminal advanced current.');
    identical(after.operating.cache, before.operating.cache, 'Failed terminal advanced cache.');
    identical(peerAfter.broker, peerBefore.broker, 'Failed terminal advanced Broker.');
    check(after.status.publications === before.status.publications, 'Failed terminal advanced publication.');
    for (const counter of ['releases', 'issued', 'registered', 'creates']) check(peerAfter.counts[counter] === peerBefore.counts[counter], 'Failed terminal advanced ' + counter);
  }
  if (fault === 'late-progress') {
    identical(after.physical, before.physical, 'Late-progress transaction left partial SQL.');
    identical(after.restored, before.restored, 'Late-progress transaction changed complete evidence.');
    const statements = sample.fault.delta.statements.filter((row: any) => row.phase === 'commit');
    const failedIndex = statements.findIndex((row: any) => row.kind === 'favoritesReceipt' && !row.succeeded);
    check(failedIndex > 0 && statements.slice(0, failedIndex).some((row: any) => row.kind === 'freeze' && row.succeeded && row.query.startsWith('INSERT INTO relay_snapshot_manifests')), 'Late-progress trigger did not follow a successful freeze upsert.');
    check(sample.fault.delta.syncEntries === 0, 'Aborted transaction entered storage.sync.');
    await response(f, '/operating/late-progress?on=0');
  } else {
    check(after.restored.tenants[0].broker.associations.freezes[0].released === 'committed', 'Post-sync gate lacks complete terminal evidence.');
    check(after.restored.tenants[0].favoritesSuccession.receipts[0].status === 'pending', 'Post-sync gate lost complete progress.');
  }
}

async function sequence(id: OperatingCase, repeat: number, fault?: string) {
  const sample: any = { id: fault ? `${id}-${fault}` : `${id}-${repeat}`, case: id, repeat, faultMode: fault ?? null,
    startedAt: new Date().toISOString(), phases: [], responses: [], inspections: [], fileInventories: [], outcome: 'running', failures: [] };
  const initial = structuredClone(datasets[id]), next = ['L', 'O'].includes(id) ? undefined : operatingWarmUpdate(id, initial);
  let f: Awaited<ReturnType<typeof accountingWorker>> | undefined;
  let primaryFailure: { error: unknown } | undefined;
  try {
    f = await timed(sample, 'coldConstruction', () => accountingWorker());
    sample.ownedDirectory = f.directory;
    const preload = await timed(sample, 'coldPreload', () => response(f!, '/mutate', initial)); sample.responses.push(preload);
    check(preload.status === 200, 'Cold preload refused: ' + preload.body);
    const cold = await inspect(sample, f, 'cold'); identical(cold.status.current, initial, 'Cold input identity mismatch.');
    sample.fileInventories.push(await files(f.directory, 'live-after-preload'));
    if (fault) await faultLarge(sample, f, fault);
    else if (id === 'L' || id === 'O') await nominalLarge(sample, f);
    else {
      const before = await f.json('/operating/status'), reply = await timed(sample, 'warmUpdate', () => response(f!, '/mutate', next)); sample.responses.push(reply);
      check(reply.status === 200, 'Warm update failed: ' + reply.body);
      const after = await inspect(sample, f, 'warm'); identical(after.status.current, next, 'Warm full input identity mismatch.');
      sample.warmDelta = statementDelta(before, after.operating); sample.changedRows = changedRows(cold.physical, after.physical);
    }
    const exposed = await f.json('/restore');
    await timed(sample, 'restartConstructionWithDisposedFileProbe', () => f!.restart(async () => {
      const start = performance.now(); sample.fileInventories.push(await files(f!.directory, 'disposed-before-restart'));
      sample.disposedRestartFileProbeMilliseconds = performance.now() - start;
    }));
    const readback = await timed(sample, 'restartValidatedWorkerReadback', async () => {
      const current = await f!.json('/status'); identical(current.current, exposed, 'Persisted restart exposed a different complete atomic snapshot.'); return current;
    });
    check(readback.publications === 0 && readback.failures === 0, 'Restart replayed a mutation/publication.');
    const restarted = await inspect(sample, f, 'restarted'); identical(restarted.restored, exposed, 'Restart restore mismatch.');
    sample.fileInventories.push(await files(f.directory, 'live-after-restart'));
    sample.restart = { exposedSnapshotSha256: stateDigest(exposed), reopenedSnapshotSha256: stateDigest(restarted.restored), nativeEffect: 'no peer opened or native effect supplier registered' };
    sample.outcome = 'passed';
  } catch (error) {
    primaryFailure = { error };
    sample.outcome = 'failed'; sample.failures.push({ error: String(error), stack: error instanceof Error ? error.stack : undefined });
    if (f) {
      try { await inspect(sample, f, 'failure-exposed', false); } catch (inspectionError) { sample.failures.push({ inspectionError: String(inspectionError) }); }
    }
  } finally {
    await finalizeOperatingSample(sample, join(output, `${sample.id}.json`), f ? async () => {
        await timed(sample, 'cleanup', () => f!.close(async () => { sample.fileInventories.push(await files(f!.directory, 'disposed-before-owned-removal')); }));
        sample.cleanup = { ownedDirectoryRemoved: await access(f!.directory).then(() => false, () => true) };
    } : undefined, primaryFailure);
  }
}

// Fixed sequential execution: eighteen nominal sequences and six declared fault attempts.
for (const id of operatingCases) for (const repeat of [1, 2, 3]) {
  test(`operating ${id} sample ${repeat}`, () => sequence(id, repeat), 30000);
}
for (const id of ['L', 'O'] as const) for (const fault of ['late-progress', 'hold', 'reject']) {
  test(`operating ${id} ${fault}`, () => sequence(id, 1, fault), 30000);
}
