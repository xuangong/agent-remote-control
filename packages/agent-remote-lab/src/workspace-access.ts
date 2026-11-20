import { displayLeaseValid, type ChannelLink, withMessageKey } from '@orchardworks/agent-client';
import { createContext } from 'react';

export type WorkspaceAccess = { user?: { id: string; name?: string; email?: string }; basePath: string; expiresAt: number; refreshAfterMs?: number };
export const workspaceDisplayLifetime = 24 * 60 * 60 * 1000;
const accessKey = 'agent-remote:workspace-access';
const automaticKey = 'agent-remote:automatic-sign-in';
const logoutKey = 'agent-remote:signed-out';
export const WorkspaceReady = createContext(true);
/** Where the page's transport reports the device's link to the Relay; GatewayController provides it and shows the one indicator. */
export interface RelayLinkReporter {
  report(link: ChannelLink): void;
  /** How the banner's Retry reopens the link now; undefined when the page's transport cannot. */
  setReopen(reopen: (() => void) | undefined): void;
}
export const RelayLinkReport = createContext<RelayLinkReporter>({ report: () => undefined, setReopen: () => undefined });

export function parseAccess(value: unknown): WorkspaceAccess {
  if (!value || typeof value !== 'object' || !('basePath' in value) || !('expiresAt' in value) ||
    typeof value.basePath !== 'string' || !/^\/u\/[a-f0-9]{64}\/$/.test(value.basePath) ||
    typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) ||
    ('refreshAfterMs' in value && (typeof value.refreshAfterMs !== 'number' || !Number.isFinite(value.refreshAfterMs) || value.refreshAfterMs < 0))) throw new Error('Invalid access response.');
  if ('user' in value && (!value.user || typeof value.user !== 'object' || !('id' in value.user) || typeof value.user.id !== 'string' || !value.user.id ||
    ('name' in value.user && typeof value.user.name !== 'string') || ('email' in value.user && typeof value.user.email !== 'string'))) throw new Error('Invalid account identity.');
  return value as WorkspaceAccess;
}
export function workspaceSignedOut(): boolean {
  try { return !!localStorage.getItem(logoutKey); } catch { return false; }
}
export function previousWorkspacePath(): string | undefined {
  try { return parseAccess(JSON.parse(localStorage.getItem(accessKey) ?? 'null').access).basePath; } catch { return; }
}
export function readWorkspaceAccess(): WorkspaceAccess | undefined {
  try {
    if (localStorage.getItem(logoutKey)) return;
    const saved = JSON.parse(localStorage.getItem(accessKey) ?? 'null');
    const age = Date.now() - saved.confirmedAt;
    if (!Number.isFinite(age) || age < 0 || age >= workspaceDisplayLifetime) return;
    return parseAccess(saved.access);
  } catch { return; }
}
export function rememberWorkspaceAccess(access: WorkspaceAccess): void {
  try {
    // Store display identity, never credentials or authorization expiry.
    // The lease's own expiry rides with the Relay URL it was granted for (`basePath` holds the person): until it passes, the stored rows may show before the Relay answers.
    localStorage.setItem(accessKey, JSON.stringify({ confirmedAt: Date.now(), access: { basePath: access.basePath, user: access.user, expiresAt: 0 }, lease: { expiresAt: access.expiresAt } }));
    localStorage.removeItem(logoutKey);
  } catch { /* Private browsing remains usable without persistence. */ }
}
/** The end of the lease the last `GET /auth/status` reported, for the Relay URL the cached access names. Absent or malformed means none. */
export function readStoredLease(): number | undefined {
  try {
    if (localStorage.getItem(logoutKey)) return;
    const expiresAt = JSON.parse(localStorage.getItem(accessKey) ?? 'null')?.lease?.expiresAt;
    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  } catch { return; }
}
export function forgetWorkspaceAccess(): void {
  try { localStorage.removeItem(accessKey); localStorage.setItem(logoutKey, '1'); } catch { /* Keep the in-memory sign-out. */ }
}
export function prepareManualSignIn(): void {
  try { localStorage.removeItem(logoutKey); sessionStorage.setItem(automaticKey, String(Date.now())); } catch { /* Manual navigation works without storage. */ }
}
export function claimAutomaticSignIn(): boolean {
  try {
    if (localStorage.getItem(logoutKey) || !localStorage.getItem(accessKey)) return false;
    const attempted = Number(sessionStorage.getItem(automaticKey));
    // A successful callback must not immediately reopen the same failing chain.
    if (attempted && Date.now() - attempted < 10 * 60 * 1000) return false;
    sessionStorage.setItem(automaticKey, String(Date.now()));
    return true;
  } catch { return false; }
}

/**
 * ready: access is confirmed. confirming: the local copy of the lease ran out and the Relay is being asked; live
 * sockets stay open but hold what they send, and requests wait, until the answer.
 */
type Gate = { optimisticUntil?: number; ready: boolean; confirming?: boolean; retired?: boolean; listeners: Set<() => void> };
const gates = new Map<string, Gate>();
export function scopeFor(input: string): string {
  const url = new URL(input, globalThis.location?.origin ?? 'http://localhost');
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return url.origin + (url.pathname.match(/^\/u\/[a-f0-9]{64}\//)?.[0] ?? '/');
}
export function setWorkspaceReady(basePath: string, ready: boolean, optimisticUntil?: number): void {
  const scope = scopeFor(basePath);
  const gate = gates.get(scope) ?? { ready: false, listeners: new Set() };
  gates.set(scope, gate);
  gate.ready = ready; gate.confirming = false;
  // A confirmed lease needs no optimistic window; a cached one opens it until its own expiry.
  gate.optimisticUntil = ready ? undefined : optimisticUntil ?? gate.optimisticUntil;
  if (ready) gate.retired = false;
  for (const listener of [...gate.listeners]) listener();
}
/** Holds the workspace's traffic, without closing its live sockets, while the Relay confirms access. */
export function confirmWorkspaceAccess(basePath: string): void {
  const gate = gates.get(scopeFor(basePath));
  if (!gate?.ready || gate.confirming) return;
  gate.confirming = true;
  for (const listener of [...gate.listeners]) listener();
}
export function retireWorkspace(basePath: string): void {
  setWorkspaceReady(basePath, false);
  const gate = gates.get(scopeFor(basePath))!;
  gate.retired = true;
  for (const listener of [...gate.listeners]) listener();
}
function gateFor(input: RequestInfo | URL): Gate | undefined {
  return gates.get(scopeFor(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url));
}
export const workspaceFetch: typeof fetch = async (input, init) => {
  const gate = gateFor(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  if (gate?.retired) throw new Error('Workspace access was retired.');
  while (gate && (!gate.ready || gate.confirming)) {
    if (!gate.ready && method !== 'GET' && method !== 'HEAD') throw withMessageKey(new Error('Workspace access is restoring. Try again when connected.'), 'client.view.accessRestoring');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { gate.listeners.delete(check); signal?.removeEventListener('abort', cancel); };
      const check = () => { if (gate.retired) { cleanup(); reject(new Error('Workspace access was retired.')); return; } if (gate.ready && !gate.confirming) { cleanup(); resolve(); } };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error('Request cancelled.')); };
      gate.listeners.add(check); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else check();
    });
  }
  signal?.throwIfAborted();
  return globalThis.fetch(input, init);
};

/** Frames a socket may hold while access is confirmed; beyond them it closes and its owner reconnects. */
const HELD_FRAMES = 256, HELD_BYTES = 4 * 1024 * 1024;
/**
 * A suspended workspace cannot open sockets or send stale commands during recovery. While access is only being
 * confirmed, a live socket stays open and sends what it held once the Relay confirms access.
 */
export function workspaceSocket(url: string) {
  const gate = gateFor(url);
  let socket: WebSocket | undefined;
  let closed = false;
  let held: string[] = [], heldBytes = 0;
  const end = (reason: string) => { wrapper.close(); wrapper.onclose?.({ code: 1000, reason }); };
  const wrapper = {
    get readyState() { return closed ? 3 : socket?.readyState ?? 0; },
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
    send(data: string) {
      if (closed || (gate && !gate.ready) || socket?.readyState !== 1) throw new Error('Workspace access is restoring.');
      if (gate?.confirming || held.length) {
        held.push(data); heldBytes += data.length;
        if (held.length > HELD_FRAMES || heldBytes > HELD_BYTES) { end('Access confirmation took too long'); throw new Error('Workspace access is restoring.'); }
        return;
      }
      socket.send(data);
    },
    close() { closed = true; held = []; heldBytes = 0; gate?.listeners.delete(update); socket?.close(); },
  };
  const update = () => {
    if (closed) return;
    if (gate?.retired) { end('Access retired'); return; }
    if (gate && !gate.ready) {
      if (socket) end('Access restoring');
      return;
    }
    if (gate?.confirming) return;
    if (socket) {
      // Access is confirmed: what was held goes out in order.
      const frames = held; held = []; heldBytes = 0;
      for (const frame of frames) {
        if (closed || socket.readyState !== 1) return;
        socket.send(frame);
      }
      return;
    }
    socket = new WebSocket(url);
    socket.onopen = event => { if (!closed) wrapper.onopen?.(event); };
    socket.onmessage = event => { if (!closed) wrapper.onmessage?.(event); };
    socket.onerror = event => { if (!closed) wrapper.onerror?.(event); };
    socket.onclose = event => { if (!closed) { closed = true; gate?.listeners.delete(update); wrapper.onclose?.(event); } };
  };
  gate?.listeners.add(update);
  queueMicrotask(update);
  return wrapper;
}

/**
 * The Relay URL whose stored conversations may be read, and the only way to reach them: while the Relay has confirmed the access lease, or the lease the last
 * status reported has not ended and the Relay has not yet answered. Not after a refusal, while an expired lease is being confirmed again, or after the
 * workspace was retired. A workspace with no gate has no accounts.
 */
export function storedRowsRelay(baseUrl: string): string | undefined {
  const relayUrl = scopeFor(baseUrl);
  return displayLeaseValid(gates.get(relayUrl), Date.now()) ? relayUrl : undefined;
}
/** The Relay refused the lease (401 or 403): nothing stored shows until a confirmation, and every subscriber learns at once. */
export function revokeStoredRows(basePath: string): void {
  const gate = gates.get(scopeFor(basePath));
  if (!gate) return;
  gate.optimisticUntil = undefined;
  if (!gate.ready) for (const listener of [...gate.listeners]) listener();
}
/** The scope change signal of `storedRowsRelay`. */
export function subscribeStoredRows(baseUrl: string, listener: () => void): () => void {
  const gate = gates.get(scopeFor(baseUrl));
  if (!gate) return () => {};
  gate.listeners.add(listener);
  return () => { gate.listeners.delete(listener); };
}
