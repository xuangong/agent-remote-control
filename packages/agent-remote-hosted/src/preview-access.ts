import { randomBytes } from 'node:crypto';
import { readJson } from './request.js';

export interface PreviewSession {
  source: Request;
  subject: string;
  hostId: string;
  previewId: string;
  path: string;
  expiresAt: number;
}
interface PreviewAccessOptions {
  origin: string;
  previewOrigin: string;
  authorize(session: PreviewSession): Promise<boolean>;
  authorizeBrowser?(request: Request, session: PreviewSession): Promise<boolean>;
  now?(): number;
}

/** Handoffs carry no reusable credential and become invalid on Relay restart. */
export function createPreviewAccess(options: PreviewAccessOptions) {
  const origin = new URL(options.origin).origin;
  const previewOrigin = new URL(options.previewOrigin).origin;
  if (!['https:', 'http:'].includes(new URL(previewOrigin).protocol)) throw new Error('Invalid preview origin.');
  const secure = previewOrigin.startsWith('https:');
  if (!secure && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(previewOrigin).hostname)) throw new Error('Public previews require HTTPS.');
  const now = options.now ?? Date.now;
  const proofs = new Map<string, PreviewSession>();
  const sessions = new Map<string, PreviewSession>();
  const active = new Set<{ session: PreviewSession; cancel(): void }>();
  let closed = false;
  function prune() {
    for (const map of [proofs, sessions]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  }
  // Browser-session cookies also survive long-running WebSockets, which cannot send Set-Cookie.
  // The server enforces the sliding idle deadline and rechecks the original owner authorization.
  const name = (id: string) => `${secure ? '__Secure-' : ''}arc_preview_${id}`;
  async function valid(session: PreviewSession) {
    if (closed || session.expiresAt <= now()) return false;
    try { return await options.authorize(session); } catch { return false; }
  }
  async function validBrowser(request: Request, session: PreviewSession) {
    try { return !options.authorizeBrowser || await options.authorizeBrowser(request, session); } catch { return false; }
  }
  async function enforce() {
    await Promise.all([...active].map(async entry => { if (!await valid(entry.session)) { active.delete(entry); entry.cancel(); } }));
  }
  const timer = setInterval(() => { prune(); void enforce(); }, 15_000);
  timer.unref?.();
  return {
    issue(input: Omit<PreviewSession, 'expiresAt'>): string {
      prune();
      if (closed || proofs.size >= 1024) throw new Error('Preview entry capacity reached.');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.previewId) || !input.path.startsWith('/') || input.path.startsWith('//') || /[\\\r\n\0]/.test(input.path)) throw new Error('Invalid preview destination.');
      const prefix = `/p/${input.previewId}/`;
      if (!new URL(`/p/${input.previewId}${input.path}`, previewOrigin).pathname.startsWith(prefix)) throw new Error('Invalid preview destination.');
      const code = randomBytes(32).toString('base64url');
      // Preserve only authentication headers, never retain an upload body or AbortSignal.
      const source = new Request(origin + '/', { headers: input.source.headers });
      proofs.set(code, { ...input, source, expiresAt: now() + 60_000 });
      return previewOrigin + '/_arc/enter#' + code;
    },
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.origin !== previewOrigin) return undefined;
      const renew = /^\/p\/([A-Za-z0-9_-]{1,128})\/_arc\/renew$/.exec(url.pathname);
      if (renew) {
        if (request.method !== 'POST') return error(405);
        if (request.headers.get('origin') !== previewOrigin) return error(403);
        if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return error(415);
        const body = await readJson(request);
        if (!body || Object.keys(body).length) return error(400);
        const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim());
        const values = cookies.filter(value => value.startsWith(name(renew[1]!) + '='));
        if (values.length !== 1) return error(401);
        const token = values[0]!.slice(name(renew[1]!).length + 1);
        const session = sessions.get(token);
        if (!session || session.previewId !== renew[1] || !await valid(session) || !await validBrowser(request, session)) return error(401);
        // Extend the same object so existing HTTP and WebSocket watches keep their authorization.
        session.expiresAt = now() + 60 * 60_000;
        return Response.json({ expiresAt: session.expiresAt }, { headers: {
          'cache-control': 'no-store', 'set-cookie': `${name(session.previewId)}=${token}; Path=/p/${session.previewId}/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
        } });
      }
      if (url.pathname !== '/_arc/enter') return undefined;
      if (request.method === 'GET') {
        const nonce = randomBytes(24).toString('base64url');
        const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Open local preview</title><p id="status">Opening preview…</p><script nonce="${nonce}">const code=location.hash.slice(1);history.replaceState(null,'',location.pathname);fetch('/_arc/enter',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})}).then(async r=>{if(!r.ok)throw Error();const v=await r.json();location.replace(v.url)}).catch(()=>{document.getElementById('status').textContent='Preview entry expired or access is unavailable. Open it again from the Controller.'})</script>`;
        return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'` } });
      }
      if (request.method !== 'POST' || request.headers.get('origin') !== previewOrigin) return error(403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return error(415);
      const body = await readJson(request);
      const code = typeof body?.code === 'string' ? body.code : '';
      const session = proofs.get(code);
      if (!session || !await valid(session) || !await validBrowser(request, session)) return error(401);
      // Consume after identity verification; only one concurrent redemption can succeed.
      if (!proofs.delete(code)) return error(401);
      prune(); if (sessions.size >= 4096) return error(429);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { ...session, source: options.authorizeBrowser ? new Request(origin + '/', { headers: request.headers }) : session.source, expiresAt: now() + 60 * 60_000 });
      return Response.json({ url: `/p/${session.previewId}${session.path}` }, { headers: {
        'cache-control': 'no-store', 'set-cookie': `${name(session.previewId)}=${token}; Path=/p/${session.previewId}/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      } });
    },
    async authenticate(request: Request): Promise<PreviewSession | Response> {
      const url = new URL(request.url);
      if (url.origin !== previewOrigin) return error(403);
      const match = /^\/p\/([A-Za-z0-9_-]{1,128})(?:\/|$)/.exec(url.pathname);
      if (!match) return error(404);
      const originHeader = request.headers.get('origin');
      if ((originHeader && originHeader !== previewOrigin) || ((!['GET', 'HEAD'].includes(request.method) || request.headers.has('upgrade')) && originHeader !== previewOrigin)) return error(403);
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim());
      const values = cookies.filter(value => value.startsWith(name(match[1]!) + '='));
      if (values.length !== 1) return error(401);
      const session = sessions.get(values[0]!.slice(name(match[1]!).length + 1));
      if (!session || session.previewId !== match[1] || !await valid(session) || !await validBrowser(request, session)) return error(401);
      return session;
    },
    activity(session: PreviewSession): boolean {
      if (closed || session.expiresAt <= now()) return false;
      session.expiresAt = now() + 60 * 60_000;
      return true;
    },
    watch(session: PreviewSession, cancel: () => void): () => void {
      const entry = { session, cancel }; active.add(entry);
      return () => { active.delete(entry); };
    },
    enforce,
    close() { closed = true; clearInterval(timer); proofs.clear(); sessions.clear(); for (const entry of active) entry.cancel(); active.clear(); },
  };
}
function error(status: number) { return Response.json({ error: 'Preview access is unavailable. Open it from the Controller.' }, { status, headers: { 'cache-control': 'no-store' } }); }
