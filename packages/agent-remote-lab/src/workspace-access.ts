import { createContext } from 'react';

export type WorkspaceAccess = { user?: { id: string; name?: string; email?: string }; basePath: string; expiresAt: number; refreshAfterMs?: number };
export const workspaceDisplayLifetime = 24 * 60 * 60 * 1000;
const accessKey = 'agent-remote:workspace-access';
const automaticKey = 'agent-remote:automatic-sign-in';
const logoutKey = 'agent-remote:signed-out';
export const WorkspaceReady = createContext(true);

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
    localStorage.setItem(accessKey, JSON.stringify({ confirmedAt: Date.now(), access: { basePath: access.basePath, user: access.user, expiresAt: 0 } }));
    localStorage.removeItem(logoutKey);
  } catch { /* Private browsing remains usable without persistence. */ }
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

type Gate = { ready: boolean; retired?: boolean; listeners: Set<() => void> };
const gates = new Map<string, Gate>();
function scopeFor(input: string): string {
  const url = new URL(input, globalThis.location?.origin ?? 'http://localhost');
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  return url.origin + (url.pathname.match(/^\/u\/[a-f0-9]{64}\//)?.[0] ?? '/');
}
export function setWorkspaceReady(basePath: string, ready: boolean): void {
  const scope = scopeFor(basePath);
  const gate = gates.get(scope) ?? { ready: false, listeners: new Set() };
  gates.set(scope, gate);
  gate.ready = ready;
  if (ready) gate.retired = false;
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
  while (gate && !gate.ready) {
    if (method !== 'GET' && method !== 'HEAD') throw new Error('Workspace access is restoring. Try again when connected.');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { gate.listeners.delete(check); signal?.removeEventListener('abort', cancel); };
      const check = () => { if (gate.retired) { cleanup(); reject(new Error('Workspace access was retired.')); return; } if (gate.ready) { cleanup(); resolve(); } };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error('Request cancelled.')); };
      gate.listeners.add(check); signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel(); else check();
    });
  }
  signal?.throwIfAborted();
  return globalThis.fetch(input, init);
};

/** A suspended workspace cannot open sockets or send stale commands during recovery. */
export function workspaceSocket(url: string) {
  const gate = gateFor(url);
  let socket: WebSocket | undefined;
  let closed = false;
  const wrapper = {
    get readyState() { return closed ? 3 : socket?.readyState ?? 0; },
    onopen: null as ((event: unknown) => void) | null,
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onerror: null as ((event: unknown) => void) | null,
    onclose: null as ((event: unknown) => void) | null,
    send(data: string) { if (closed || (gate && !gate.ready) || socket?.readyState !== 1) throw new Error('Workspace access is restoring.'); socket.send(data); },
    close() { closed = true; gate?.listeners.delete(update); socket?.close(); },
  };
  const update = () => {
    if (closed) return;
    if (gate?.retired) { wrapper.close(); wrapper.onclose?.({ code: 1000, reason: 'Access retired' }); return; }
    if (gate && !gate.ready) {
      if (socket) { wrapper.close(); wrapper.onclose?.({ code: 1000, reason: 'Access restoring' }); }
      return;
    }
    if (socket) return;
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
