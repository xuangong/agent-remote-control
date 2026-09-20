import { createHash, randomBytes } from 'node:crypto';
import { controllerPath } from './controller-location.js';
import { readJson } from './request.js';
import type { PreviewSession } from './preview-access.js';

interface Identity { hostId: string; previewId: string }
interface Entry extends Identity { origin: string; path: string; browserHash: string; expiresAt: number; source?: Request; subject?: string; code?: string }
interface Session extends PreviewSession { origin: string }
interface Options {
  origin: string;
  lookup(url: URL): Identity | undefined;
  authorize(session: PreviewSession): Promise<boolean>;
  now?(): number;
}
const secret = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const error = (status: number) => Response.json({ error: 'Preview access is unavailable. Open it again from Agent Remote.' }, { status, headers: { 'cache-control': 'no-store' } });

export function createSubdomainPreviewAccess(options: Options) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Entry>();
  const proofs = new Map<string, string>();
  const sessions = new Map<string, Session>();
  const watches = new Set<{ session: PreviewSession; cancel(): void }>();
  let closed = false;
  const secure = options.origin.startsWith('https:');
  const cookieName = `${secure ? '__Host-' : ''}arc_preview`;
  const challengeName = (id: string) => `${secure ? '__Host-' : ''}arc_challenge_${id}`;
  const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  function cookie(request: Request, name: string): string | undefined {
    const matches = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(name + '='));
    return matches.length === 1 ? matches[0]!.slice(name.length + 1) : undefined;
  }
  function prune() {
    for (const [id, entry] of pending) if (entry.expiresAt <= now()) { pending.delete(id); if (entry.code) proofs.delete(entry.code); }
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
  }
  async function valid(session: PreviewSession) {
    if (closed || session.expiresAt <= now()) return false;
    try { return await options.authorize(session); } catch { return false; }
  }
  async function enforce() {
    await Promise.all([...watches].map(async entry => { if (!await valid(entry.session)) { watches.delete(entry); entry.cancel(); } }));
  }
  const timer = setInterval(() => { prune(); void enforce(); }, 15_000); timer.unref?.();
  function createChallenge(request: Request, path: string, navigate: boolean): Response {
    prune(); const url = new URL(request.url); const identity = options.lookup(url);
    if (!identity) return error(404);
    if (closed || pending.size >= 1024) return error(429);
    if (!validPath(path, url.origin)) return error(400);
    const id = secret(); const browser = secret();
    pending.set(id, { ...identity, origin: url.origin, path, browserHash: digest(browser), expiresAt: now() + 300_000 });
    const headers = { 'cache-control': 'no-store', 'set-cookie': `${challengeName(id)}=${browser}; ${flags}; Max-Age=300` };
    if (navigate) return new Response(null, { status: 303, headers: { ...headers,
      location: options.origin + controllerPath({ ...identity, previewPath: path, previewChallenge: id }) } });
    return Response.json({ challenge: id }, { headers });
  }
  async function authenticate(request: Request): Promise<Session | Response> {
    const url = new URL(request.url); const identity = options.lookup(url);
    if (!identity) return error(404);
    const origin = request.headers.get('origin');
    if ((origin && origin !== url.origin) || ((!['GET', 'HEAD'].includes(request.method) || request.headers.has('upgrade')) && origin !== url.origin)) return error(403);
    const session = sessions.get(cookie(request, cookieName) ?? '');
    if (!session || session.origin !== url.origin || session.previewId !== identity.previewId || session.hostId !== identity.hostId || !await valid(session)) return error(401);
    return session;
  }
  async function handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (!options.lookup(url)) return error(404);
    if (!['/_arc/start', '/_arc/challenge', '/_arc/enter', '/_arc/renew'].includes(url.pathname)) return undefined;
    const origin = request.headers.get('origin');
    if (origin && origin !== options.origin && origin !== url.origin) return error(403);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method === 'GET' && url.pathname === '/_arc/start') return createChallenge(request, url.searchParams.get('path') ?? '/', true);
    if (request.method === 'GET' && url.pathname === '/_arc/enter') {
      const nonce = secret();
      return new Response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Open local preview</title><p id="status">Opening preview…</p><script nonce="${nonce}">const code=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch('/_arc/enter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})}).then(async r=>{if(!r.ok)throw Error();location.replace((await r.json()).url)}).catch(()=>document.getElementById('status').textContent='Preview entry expired. Open the tunnel again.')</script>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors ${options.origin}` } });
    }
    if (request.method !== 'POST' || (origin !== options.origin && origin !== url.origin)) return error(403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return error(415);
    const body = await readJson(request);
    if (url.pathname === '/_arc/challenge') return createChallenge(request, typeof body?.path === 'string' ? body.path : '/', false);
    if (url.pathname === '/_arc/renew') {
      // The exact control origin may renew a retained iframe; app mutations still require the target origin.
      const headers = new Headers(request.headers); headers.set('origin', url.origin);
      const session = await authenticate(new Request(request.url, { method: 'POST', headers }));
      if (session instanceof Response) return session;
      session.expiresAt = now() + 3_600_000;
      return Response.json({ expiresAt: session.expiresAt }, { headers: { 'cache-control': 'no-store' } });
    }
    if (url.pathname !== '/_arc/enter') return error(404);
    const code = typeof body?.code === 'string' ? body.code : '';
    const id = proofs.get(code); const entry = id ? pending.get(id) : undefined;
    if (!entry || !id || !entry.source || !entry.subject || entry.origin !== url.origin || entry.expiresAt <= now()
      || digest(cookie(request, challengeName(id)) ?? '') !== entry.browserHash) return error(401);
    const session: Session = { ...entry, source: entry.source, subject: entry.subject, expiresAt: entry.expiresAt };
    if (!await valid(session)) return error(401);
    if (!proofs.delete(code)) return error(401);
    pending.delete(id); prune();
    if (sessions.size >= 4096) return error(429);
    session.expiresAt = now() + 3_600_000;
    const token = secret(); sessions.set(token, session);
    return Response.json({ url: entry.path }, { headers: { 'cache-control': 'no-store', 'set-cookie': `${cookieName}=${token}; ${flags}` } });
  }
  return {
    async handle(request: Request) {
      const response = await handle(request);
      if (response && request.headers.get('origin') === options.origin) {
        response.headers.set('access-control-allow-origin', options.origin);
        response.headers.set('access-control-allow-credentials', 'true');
        response.headers.set('access-control-allow-methods', 'POST, OPTIONS');
        response.headers.set('access-control-allow-headers', 'content-type');
        response.headers.append('vary', 'Origin');
      }
      return response;
    },
    challenge: (request: Request) => createChallenge(request, new URL(request.url).pathname + new URL(request.url).search, true),
    async approve(id: string, source: Request, subject: string): Promise<string | undefined> {
      const entry = pending.get(id);
      if (!entry || entry.code || !await valid({ ...entry, source, subject })) return undefined;
      // Recheck after asynchronous authorization so concurrent approvals cannot replace a proof.
      if (entry.code || pending.get(id) !== entry || entry.expiresAt <= now()) return undefined;
      const code = secret(); entry.code = code; entry.subject = subject; entry.expiresAt = now() + 60_000;
      entry.source = new Request(options.origin, { headers: source.headers }); proofs.set(code, id);
      return code;
    },
    entryUrl(id: string, code: string): string | undefined {
      const entry = pending.get(id); return entry?.code === code ? entry.origin + '/_arc/enter#' + code : undefined;
    },
    authenticate, enforce,
    activity(session: PreviewSession) { if (closed || session.expiresAt <= now()) return false; session.expiresAt = now() + 3_600_000; return true; },
    watch(session: PreviewSession, cancel: () => void) { const entry = { session, cancel }; watches.add(entry); return () => { watches.delete(entry); }; },
    close() { closed = true; clearInterval(timer); for (const entry of watches) entry.cancel(); watches.clear(); pending.clear(); proofs.clear(); sessions.clear(); },
  };
}

function validPath(path: string, origin: string): boolean {
  return path.length <= 4096 && path.startsWith('/') && !path.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(path)
    && new URL(path, origin).origin === origin && !new URL(path, origin).pathname.startsWith('/_arc/');
}
