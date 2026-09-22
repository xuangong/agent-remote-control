import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRelayDiagnosticSink } from './relay-diagnostics.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function location() { const root = await mkdtemp(join(tmpdir(), 'relay-diagnostics-')); roots.push(root); return join(root, 'relay-diagnostics.log'); }
const entry = { id: 'event-1', timestamp: '2026-09-20T01:02:03.000Z', source: 'relay' as const,
  hostId: 'host-1', relayInstanceId: 'relay-1', event: 'host_disconnected' as const };

it('appends complete private records with the original event timestamp', async () => {
  const path = await location(); const sink = createRelayDiagnosticSink({ path });
  await sink.append([entry]);
  expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual(entry);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it('rotates complete records within both file size and archive count bounds', async () => {
  const path = await location(); const sink = createRelayDiagnosticSink({ path, maxBytes: 250, archiveCount: 2 });
  for (let index = 0; index < 6; index++) await sink.append([{ ...entry, id: `event-${index}` }]);
  expect((await readdir(join(path, '..'))).sort()).toEqual(['relay-diagnostics.log', 'relay-diagnostics.log.1', 'relay-diagnostics.log.2']);
  for (const suffix of ['', '.1', '.2']) {
    expect((await stat(path + suffix)).size).toBeLessThanOrEqual(250);
    expect((await stat(path + suffix)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.parse((await readFile(path, 'utf8')).trim()).id).toBe('event-5');
  expect(JSON.parse((await readFile(`${path}.2`, 'utf8')).trim()).id).toBe('event-3');
});

it('rejects unvalidated records without persisting arbitrary text or credentials', async () => {
  const path = await location(); const sink = createRelayDiagnosticSink({ path });
  await expect(sink.append([{ ...entry, message: 'credential-secret' } as typeof entry])).rejects.toThrow();
  await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

it('propagates actual append failures and remains usable after repair', async () => {
  const path = join(await location(), 'relay-diagnostics.log'); const sink = createRelayDiagnosticSink({ path });
  await expect(sink.append([entry])).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(join(path, '..'));
  await sink.append([entry]);
  expect(JSON.parse((await readFile(path, 'utf8')).trim())).toEqual(entry);
});

it('bounds preexisting oversized logs and removes obsolete numeric archives', async () => {
  const path = await location();
  await writeFile(path, `${'x'.repeat(1000)}\n${JSON.stringify(entry)}\n`);
  await writeFile(`${path}.4`, 'obsolete');
  const sink = createRelayDiagnosticSink({ path, maxBytes: 250, archiveCount: 2 });
  await sink.append([{ ...entry, id: 'event-2' }]);
  expect((await stat(`${path}.1`)).size).toBeLessThanOrEqual(250);
  expect(JSON.parse((await readFile(`${path}.1`, 'utf8')).trim())).toEqual(entry);
  await expect(stat(`${path}.4`)).rejects.toMatchObject({ code: 'ENOENT' });
});
