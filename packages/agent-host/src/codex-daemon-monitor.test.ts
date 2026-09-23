import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDaemonMonitor } from './codex-daemon-monitor.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('records changes once and imports bounded native events without carrying arbitrary fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-monitor-')); roots.push(root);
  const home = join(root, 'home'); const directory = join(home, 'app-server-daemon'); await mkdir(directory, { recursive: true });
  const record = { pid: 99999999, processStartTime: 'not a live process' };
  await writeFile(join(directory, 'app-server.pid'), JSON.stringify(record));
  const monitor = createDaemonMonitor(root, home);
  try {
    await monitor.sample('startup'); await monitor.sample('interval');
    await writeFile(join(directory, 'app-server.pid'), JSON.stringify({ ...record, pid: 99999998 }));
    await writeFile(join(directory, 'lifecycle.jsonl'), JSON.stringify({ event: 'daemon_stop_requested', timestampMs: 1790135190000,
      pid: 42, instanceId: 'instance', targetPid: 99999998, signal: 'SIGTERM', secret: 'private-value' }) + '\n');
    await monitor.sample('interval'); await monitor.sample('interval');
    const text = await readFile(join(root, 'codex-daemon.log'), 'utf8');
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.event === 'daemon_process_snapshot')).toHaveLength(2);
    expect(events.filter(event => event.event === 'native_daemon_event')).toHaveLength(1);
    expect(events.find(event => event.event === 'native_daemon_event').native).toMatchObject({ event: 'daemon_stop_requested', timestampMs: 1790135190000, pid: 42, targetPid: 99999998 });
    expect(text).not.toContain('private-value');
  } finally { monitor.dispose(); }
}, 10000);
it('resumes journal offsets across Controller restarts and rotation, preserving partial lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'daemon-cursors-')); roots.push(root);
  const home = join(root, 'home'); const directory = join(home, 'app-server-daemon'); await mkdir(directory, { recursive: true });
  const path = join(directory, 'lifecycle.jsonl');
  const event = JSON.stringify({ event: 'daemon_started', timestampMs: 1790135190000, pid: 1 });
  await writeFile(path, event + '\n' + event.slice(0, 10));
  const first = createDaemonMonitor(root, home); await first.sample('startup'); first.dispose();
  await writeFile(path, event + '\n' + event + '\n');
  const second = createDaemonMonitor(root, home);
  try {
    await second.sample('startup');
    const { rename } = await import('node:fs/promises');
    await rename(path, path + '.1');
    await writeFile(path, event + '\n');
    await second.sample('interval');
    const events = (await readFile(join(root, 'codex-daemon.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(event => event.event === 'native_daemon_event')).toHaveLength(3);
  } finally { second.dispose(); }
}, 10000);
