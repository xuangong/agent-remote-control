import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import net from 'node:net';
import { dirname } from 'node:path';
import type { PreviewPathMode, PreviewRegistration, PreviewSnapshot, PreviewSource } from '../types.js';
import { canonicalizeLoopbackTarget, type LoopbackTargetOptions } from './loopback.js';

export type { PreviewPathMode, PreviewRegistration, PreviewSnapshot, PreviewSource } from '../types.js';
export interface PreviewRegistry {
  register(input: { target: string; source: PreviewSource; pathMode?: PreviewPathMode }): Promise<PreviewRegistration>;
  unregister(id: string): Promise<PreviewRegistration | undefined>;
  snapshot(): PreviewSnapshot;
  subscribe(callback: (snapshot: PreviewSnapshot) => void): () => void;
  lookup(id: string): PreviewRegistration | undefined;
  signal(id: string): AbortSignal;
  close(): Promise<void>;
}
export interface PreviewRegistryOptions extends LoopbackTargetOptions {
  filePath: string; ttlMs?: number; maxRecords?: number; maxTombstones?: number; now?: () => number;
  probe?: boolean; probeTimeoutMs?: number;
}

type StoredState = { version: 1; revision: number; registrations: PreviewRegistration[] };

function clone<T>(value: T): T { return structuredClone(value); }
function validState(value: unknown): value is StoredState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<StoredState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 0 || !Array.isArray(state.registrations)) return false;
  if (state.registrations.length > 384) return false;
  const ids = new Set<string>();
  return state.registrations.every(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length < 16 || ids.has(item.id)) return false;
    ids.add(item.id);
    if (typeof item.target !== 'string' || !['active', 'expired', 'unregistered'].includes(item.status)) return false;
    if (!Number.isSafeInteger(item.createdAt) || !Number.isSafeInteger(item.expiresAt) || item.createdAt < 0 || item.expiresAt < item.createdAt) return false;
    if (!Number.isSafeInteger(item.revision) || item.revision < 1 || item.revision > state.revision!) return false;
    if (item.pathMode !== 'strip' && item.pathMode !== 'preserve') return false;
    if (!Array.isArray(item.sources) || item.sources.length === 0 || item.sources.length > 256) return false;
    if (!item.sources.every(source => source && typeof source.sessionId === 'string' && source.sessionId.length > 0 && source.sessionId.length <= 256 && typeof source.itemId === 'string' && source.itemId.length > 0 && source.itemId.length <= 256)) return false;
    try { return canonicalizeLoopbackTarget(item.target) === item.target; } catch { return false; }
  });
}

async function probeTarget(target: string, timeoutMs: number) {
  const url = new URL(target);
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    const timer = setTimeout(() => socket.destroy(new Error('Preview target probe timed out.')), timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

export async function createPreviewRegistry(options: PreviewRegistryOptions): Promise<PreviewRegistry> {
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('Preview TTL must be a positive integer.');
  const maxRecords = options.maxRecords ?? 256;
  const maxTombstones = options.maxTombstones ?? 128;
  const now = options.now ?? Date.now;
  const epoch = randomUUID();
  let revision = 0;
  let closed = false;
  const records = new Map<string, PreviewRegistration>();
  const controllers = new Map<string, AbortController>();
  const listeners = new Set<(snapshot: PreviewSnapshot) => void>();
  let writeChain = Promise.resolve();
  let mutationChain = Promise.resolve();
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    const parsed = JSON.parse(await readFile(options.filePath, 'utf8')) as unknown;
    if (!validState(parsed)) throw new Error('Preview registration state is invalid.');
    revision = parsed.revision;
    for (const entry of parsed.registrations) {
      records.set(entry.id, clone(entry));
      if (entry.status === 'active') controllers.set(entry.id, new AbortController());
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  function currentSnapshot(): PreviewSnapshot {
    return { epoch, revision, registrations: [...records.values()].map(clone).sort((a, b) => a.createdAt - b.createdAt) };
  }
  function notify() { const value = currentSnapshot(); listeners.forEach(listener => listener(value)); }
  function state(): StoredState { return { version: 1, revision, registrations: [...records.values()].map(clone) }; }
  async function writeState() {
    if (closed) throw new Error('Preview registry is closed.');
    const content = `${JSON.stringify(state(), null, 2)}\n`;
    await mkdir(dirname(options.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${options.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, options.filePath); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
    const directory = await open(dirname(options.filePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  function persist() { const pending = writeChain.then(writeState); writeChain = pending.catch(() => undefined); return pending; }
  function mutate<T>(action: () => Promise<T>): Promise<T> {
    const pending = mutationChain.then(action);
    mutationChain = pending.then(() => undefined, () => undefined);
    return pending;
  }
  function prune() {
    const tombstones = [...records.values()].filter(item => item.status !== 'active').sort((a, b) => b.revision - a.revision);
    for (const item of tombstones.slice(maxTombstones)) { records.delete(item.id); controllers.delete(item.id); }
  }
  function expireDue() {
    let changed = false;
    const timestamp = now();
    for (const entry of records.values()) {
      if (entry.status === 'active' && entry.expiresAt <= timestamp) {
        entry.status = 'expired'; entry.revision = ++revision; controllers.get(entry.id)?.abort(); changed = true;
      }
    }
    if (changed) { prune(); notify(); void persist().catch(() => { closed = true; }); }
    scheduleExpiry();
  }
  function scheduleExpiry() {
    if (expiryTimer) clearTimeout(expiryTimer);
    const next = Math.min(...[...records.values()].filter(item => item.status === 'active').map(item => item.expiresAt));
    if (Number.isFinite(next)) { expiryTimer = setTimeout(expireDue, Math.max(1, next - now())); expiryTimer.unref?.(); }
  }

  expireDue();
  await writeChain;

  return {
    register(input) { return mutate(async () => {
      if (closed) throw new Error('Preview registry is closed.');
      if (!input.source || typeof input.source.sessionId !== 'string' || input.source.sessionId.length === 0 || input.source.sessionId.length > 256
        || typeof input.source.itemId !== 'string' || input.source.itemId.length === 0 || input.source.itemId.length > 256) throw new Error('Preview source is invalid.');
      expireDue();
      const target = canonicalizeLoopbackTarget(input.target, options);
      const pathMode = input.pathMode ?? 'strip';
      const existing = [...records.values()].find(item => item.status === 'active' && item.target === target && item.pathMode === pathMode);
      if (existing) {
        if (!existing.sources.some(source => source.sessionId === input.source.sessionId && source.itemId === input.source.itemId)) {
          if (existing.sources.length >= 256) throw new Error('Preview source capacity is exhausted.');
          const previous = clone(existing); existing.sources.push(clone(input.source)); existing.revision = ++revision;
          try { await persist(); } catch (error) { records.set(existing.id, previous); revision--; throw error; }
          notify();
        }
        return clone(existing);
      }
      if ([...records.values()].filter(item => item.status === 'active').length >= maxRecords) throw new Error('Preview registration capacity is exhausted.');
      if (options.probe !== false) await probeTarget(target, options.probeTimeoutMs ?? 1000);
      const timestamp = now();
      const entry: PreviewRegistration = { id: randomBytes(18).toString('base64url'), target, status: 'active', createdAt: timestamp, expiresAt: timestamp + ttlMs, revision: ++revision, pathMode, sources: [clone(input.source)] };
      records.set(entry.id, entry); controllers.set(entry.id, new AbortController());
      try { await persist(); } catch (error) { records.delete(entry.id); controllers.delete(entry.id); revision--; throw error; }
      scheduleExpiry(); notify(); return clone(entry);
    }); },
    unregister(id) { return mutate(async () => {
      if (closed) throw new Error('Preview registry is closed.');
      expireDue();
      const entry = records.get(id);
      if (!entry) return undefined;
      if (entry.status !== 'unregistered') {
        const previous = clone(entry); entry.status = 'unregistered'; entry.revision = ++revision; controllers.get(id)?.abort();
        try { prune(); await persist(); } catch (error) { records.set(id, previous); revision--; throw error; }
        notify();
      }
      return clone(entry);
    }); },
    snapshot() { expireDue(); return currentSnapshot(); },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    lookup(id) { expireDue(); const item = records.get(id); return item ? clone(item) : undefined; },
    signal(id) { expireDue(); let controller = controllers.get(id); if (!controller) { controller = new AbortController(); controller.abort(); } return controller.signal; },
    async close() { if (closed) return; if (expiryTimer) clearTimeout(expiryTimer); await mutationChain; await writeChain; closed = true; for (const controller of controllers.values()) controller.abort(); listeners.clear(); },
  };
}
