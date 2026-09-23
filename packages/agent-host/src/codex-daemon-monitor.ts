import { open, stat, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { windowsCodexDaemonDirectory } from '@orchardworks/agent-provider-codex';
import { createDaemonDiagnostics, readDaemonProcess } from './codex-daemon-diagnostics.js';

/** Low-frequency local observation; it never connects to, starts or restarts the daemon. */
export function createDaemonMonitor(stateDir: string, home: string) {
  const log = createDaemonDiagnostics(stateDir);
  let disposed = false;
  let active: Promise<void> | undefined;
  let identity = '';
  const cursorPath = join(stateDir, 'codex-daemon-cursors.json');
  const cursors = new Map<string, number>();
  let loaded = false;
  async function collect(reason: string) {
    // PID files are cheap to inspect. Environment probes only run when their identity changes.
    const directory = join(home, 'app-server-daemon');
    const pidPaths = process.platform === 'win32' ? [join(windowsCodexDaemonDirectory(home), 'daemon.json')] : ['app-server.pid', 'app-server-updater.pid'].map(name => join(directory, name));
    const fingerprints = await Promise.all(pidPaths.map(async path => {
      try { const file = await stat(path); return `${file.ino}:${file.size}:${file.mtimeMs}`; } catch { return 'missing'; }
    }));
    const next = fingerprints.join('|');
    if (next !== identity) {
      const [daemon, updater] = await Promise.all([readDaemonProcess(home, 'daemon'), readDaemonProcess(home, 'updater')]);
      if (disposed) return;
      log.write('daemon_process_snapshot', { reason, previousIdentity: identity || undefined, daemon, updater });
      identity = next;
    }
    if (!loaded) {
      try {
        const saved = JSON.parse(await readFile(cursorPath, 'utf8'));
        if (Array.isArray(saved)) for (const entry of saved.slice(-16)) {
          if (Array.isArray(entry) && typeof entry[0] === 'string' && Number.isSafeInteger(entry[1]) && entry[1] >= 0) cursors.set(entry[0], entry[1]);
        }
      } catch {}
      loaded = true;
    }
    let changed = false;
    for (const suffix of ['.3', '.2', '.1', '']) {
      const path = join(directory, `lifecycle.jsonl${suffix}`);
      let file;
      try {
        file = await open(path, 'r');
        const metadata = await file.stat();
        if (!metadata.isFile()) continue;
        const key = `${home}:${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
        const savedOffset = cursors.get(key) ?? 0;
        const offset = savedOffset > metadata.size ? 0 : savedOffset;
        if (offset === metadata.size) continue;
        const start = Math.max(offset, metadata.size - 1024 * 1024);
        const buffer = Buffer.alloc(metadata.size - start);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
        const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(10);
        if (lastNewline < 0) continue;
        let text = buffer.subarray(0, lastNewline + 1).toString('utf8');
        if (start > offset) text = text.slice(text.indexOf('\n') + 1);
        for (const line of text.split('\n')) {
          const event = nativeLifecycleRecord(line);
          if (event && !disposed) log.write('native_daemon_event', { native: event, timestamp: new Date(event.timestampMs as number).toISOString(), observedAt: new Date().toISOString() });
        }
        cursors.set(key, start + lastNewline + 1);
        while (cursors.size > 16) cursors.delete(cursors.keys().next().value!);
        changed = true;
      } catch { /* Missing journals are normal for native versions without lifecycle diagnostics. */ }
      finally { await file?.close().catch(() => {}); }
    }
    if (changed && !disposed) {
      const temporary = `${cursorPath}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...cursors]), { mode: 0o600 });
      await rename(temporary, cursorPath);
    }
  }
  const sample = (reason: string): Promise<void> => {
    if (disposed) return Promise.resolve();
    return active ??= collect(reason).catch(() => {}).finally(() => { active = undefined; });
  };
  const timer = setInterval(() => { void sample('interval'); }, 30_000);
  timer.unref();
  return { sample, dispose() { disposed = true; clearInterval(timer); log.dispose(); } };
}

function nativeLifecycleRecord(line: string): Record<string, unknown> | undefined {
  if (line.length > 8192) return;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return; }
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(raw.timestampMs) || Number(raw.timestampMs) < 0 || Number(raw.timestampMs) > 8640000000000000
    || typeof raw.event !== 'string' || !/^daemon_[a-z_]+$/.test(raw.event)) return;
  const result: Record<string, unknown> = { event: raw.event, timestampMs: raw.timestampMs };
  for (const key of ['pid', 'targetPid', 'runningTurns', 'connections', 'elapsedMs', 'gracePeriodMs']) if (Number.isSafeInteger(raw[key]) && Number(raw[key]) >= 0) result[key] = raw[key];
  for (const key of ['instanceId', 'role', 'phase', 'reason', 'signal', 'outcome', 'version']) {
    if (typeof raw[key] === 'string' && /^[\w.:-]{1,128}$/.test(raw[key])) result[key] = raw[key];
  }
  if (raw.environment && typeof raw.environment === 'object') {
    const env = raw.environment as Record<string, unknown>;
    result.environment = Object.fromEntries(['OPENAI_API_KEY', 'CODEX_GATEWAY_API_KEY', 'LC_ALL'].filter(key => ['present', 'empty', 'missing', 'unknown'].includes(String(env[key]))).map(key => [key, env[key]]));
  }
  return result;
}
