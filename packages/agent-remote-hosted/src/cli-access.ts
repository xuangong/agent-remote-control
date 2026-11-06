import { createHash, randomBytes, randomInt } from 'node:crypto';
import { accessBrandMark, accessPageStyle } from './access-page.js';

/** How long an approval link stays usable, and how often a command line asks whether it was approved. */
const AUTHORIZATION_MS = 10 * 60_000;
const POLL_MS = 2_000;
const PENDING_LIMIT = 256;
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

type Approval = { token: string; basePath: string; cookieName: string; expiresAt: number };
interface Authorization { userCode: string; label: string; expiresAt: number; status: 'pending' | 'denied' | 'approved'; approval?: Approval }

/**
 * Command line sign-in: the command line asks for a code, the signed-in user approves it in a browser, and the command
 * line receives a session of its own. Pending sign-ins live in memory only; a restart asks the user to start again.
 */
export function createCliAuthorizations(now: () => number = Date.now) {
  const pending = new Map<string, Authorization>();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const prune = () => { for (const [key, value] of pending) if (value.expiresAt <= now()) pending.delete(key); };
  const byUserCode = (userCode: string) => [...pending.entries()].find(([, value]) => value.userCode === userCode && value.expiresAt > now());
  return {
    start(label: string): { deviceCode: string; userCode: string; expiresAt: number; intervalMs: number } | undefined {
      prune();
      if (pending.size >= PENDING_LIMIT) return undefined;
      const deviceCode = randomBytes(32).toString('base64url');
      let userCode: string;
      do userCode = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join(''); while (byUserCode(userCode));
      const expiresAt = now() + AUTHORIZATION_MS;
      pending.set(digest(deviceCode), { userCode, label, expiresAt, status: 'pending' });
      return { deviceCode, userCode, expiresAt, intervalMs: POLL_MS };
    },
    describe(userCode: string): { label: string; expiresAt: number; status: Authorization['status'] } | undefined {
      const found = byUserCode(userCode)?.[1];
      return found && { label: found.label, expiresAt: found.expiresAt, status: found.status };
    },
    /** Settles a pending sign-in once; approve() runs only for a pending one and supplies the session it receives. */
    async decide(userCode: string, decision: 'approve' | 'deny', approve: (label: string) => Promise<Approval | undefined>): Promise<'approved' | 'denied' | 'unavailable' | 'failed'> {
      const found = byUserCode(userCode)?.[1];
      if (!found || found.status !== 'pending') return 'unavailable';
      if (decision === 'deny') { found.status = 'denied'; return 'denied'; }
      const approval = await approve(found.label);
      if (!approval) return 'failed';
      found.status = 'approved'; found.approval = approval;
      return 'approved';
    },
    /** What the command line learns when it asks; an approved session is handed over once. */
    claim(deviceCode: string): { status: 'pending' | 'denied' | 'expired' } | { status: 'approved'; approval: Approval } {
      const key = digest(deviceCode), found = pending.get(key);
      if (!found || found.expiresAt <= now()) { pending.delete(key); return { status: 'expired' }; }
      if (found.status === 'pending') return { status: 'pending' };
      pending.delete(key);
      return found.status === 'approved' ? { status: 'approved', approval: found.approval! } : { status: 'denied' };
    },
  };
}
export type CliAuthorizations = ReturnType<typeof createCliAuthorizations>;

const escape = (value: string) => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

/** The page where a signed-in user approves or refuses a command line sign-in. */
export function cliApprovalPage(origin: string, view: { state: 'approve'; userCode: string; label: string } | { state: 'signin' | 'reauthenticate' | 'unavailable' }): Response {
  const css = 'body{margin:0}' + accessPageStyle;
  const copy = view.state === 'approve' ? { title: 'Allow command line access?', description: `${view.label} asks to act as you in Agent Remote Control: read and drive your sessions, Windows and Hosts. Allow it only if you started this sign-in.` }
    : view.state === 'signin' ? { title: 'Sign in first', description: 'Sign in to Agent Remote Control in this browser, then open the link from your terminal again.' }
    : view.state === 'reauthenticate' ? { title: 'Sign in again', description: 'Allowing command line access needs a recent sign-in. Sign in again, then open the link from your terminal again.' }
    : { title: 'This sign-in is not available', description: 'It expired or was already answered. Start again from your terminal with agent-remote-controller login.' };
  const script = view.state === 'approve' ? `
const status=document.getElementById('cli-status');
for(const button of document.querySelectorAll('[data-decision]'))button.addEventListener('click',async()=>{
  for(const other of document.querySelectorAll('[data-decision]'))other.disabled=true;
  status.textContent='Saving…';
  try{
    const response=await fetch('/auth/cli',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(view.userCode)},decision:button.dataset.decision})});
    const result=await response.json().catch(()=>({}));
    status.textContent=response.ok?(result.status==='approved'?'Allowed. Return to your terminal.':'Refused. You can close this page.'):(result.error||'This could not be saved. Start again from your terminal.');
  }catch{status.textContent='This could not be saved. Start again from your terminal.';}
});` : '';
  const actions = view.state === 'approve'
    ? `<p class="arc-access-note">Code <strong>${escape(view.userCode)}</strong>: check that your terminal shows the same.</p><div class="arc-access-actions"><button type="button" class="arc-access-action" data-decision="approve">Allow</button><button type="button" class="arc-access-secondary" data-decision="deny">Refuse</button></div><p id="cli-status" role="status"></p>`
    : view.state === 'unavailable' ? '' : `<div class="arc-access-actions"><a class="arc-access-action" href="${view.state === 'reauthenticate' ? '/auth/login?reauthenticate=1' : '/auth/login'}">Sign in</a></div>`;
  const sha = (value: string) => createHash('sha256').update(value).digest('base64');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Command line access · Agent Remote</title><style>${css}</style></head><body>
<main class="arc-access">
  <header class="arc-access-brand">${accessBrandMark}Agent Remote</header>
  <section class="arc-access-body" aria-labelledby="access-title">
    <p class="arc-access-eyebrow">Command line access</p>
    <h1 id="access-title">${escape(copy.title)}</h1>
    <p class="arc-access-description">${escape(copy.description)}</p>
    ${actions}
  </section>
  <footer class="arc-access-footer"><span>Agent Remote Control</span><span class="arc-access-host">${escape(new URL(origin).host)}</span></footer>
</main>${script ? `<script>${script}</script>` : ''}</body></html>`, { status: view.state === 'unavailable' ? 410 : 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'sha256-${sha(css)}'; ${script ? `script-src 'sha256-${sha(script)}'; connect-src 'self'; ` : ''}base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
