import { createHash, randomBytes, randomInt } from 'node:crypto';
import { accessLocale, accessWord, type AccessView } from './access-page.js';
import { cliWord, cliWordsOf, type CliWordKey } from './access-cli-words.js';
import { accessDocument, accessPanel, escapeHtml } from './auth-page.js';

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

/** The page where a signed-in user approves or refuses a command line sign-in. */
export function cliApprovalPage(origin: string, view: { state: 'approve'; userCode: string; label: string } | { state: 'signin' | 'reauthenticate' | 'unavailable' }, languages?: string | null): Response {
  const locale = accessLocale(languages);
  const key = (name: 'title' | 'description'): CliWordKey => `${view.state}.${name}` as CliWordKey;
  const card: AccessView = { kind: 'card', title: cliWord(locale, key('title')), description: cliWord(locale, key('description'), { label: view.state === 'approve' ? view.label : '' }), action: '' };
  const words = cliWordsOf(locale);
  const action = accessWord(locale, 'action.signIn');
  const script = view.state === 'approve' ? `
const words=${JSON.stringify({ saving: words['saving'], allowed: words['allowed'], refused: words['refused'], failed: words['failed'] })};
const status=document.getElementById('cli-status');
for(const button of document.querySelectorAll('[data-decision]'))button.addEventListener('click',async()=>{
  for(const other of document.querySelectorAll('[data-decision]'))other.disabled=true;
  status.textContent=words.saving;
  try{
    const response=await fetch('/auth/cli',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:${JSON.stringify(view.userCode)},decision:button.dataset.decision})});
    const result=await response.json().catch(()=>({}));
    status.textContent=response.ok?(result.status==='approved'?words.allowed:words.refused):(result.error||words.failed);
  }catch{status.textContent=words.failed;}
});` : undefined;
  const note = view.state === 'approve' ? `<p class="arc-access-note">${escapeHtml(words['approve.code']).replace('{code}', `<strong>${escapeHtml(view.userCode)}</strong>`)}</p>` : '';
  const actions = view.state === 'approve'
    ? `<button type="button" class="arc-access-action" data-decision="approve">${escapeHtml(words['approve.allow'])}</button><button type="button" class="arc-access-secondary" data-decision="deny">${escapeHtml(words['approve.refuse'])}</button>`
    : view.state === 'unavailable' ? '' : `<a class="arc-access-action" href="${view.state === 'reauthenticate' ? '/auth/login?reauthenticate=1' : '/auth/login'}">${escapeHtml(action)}</a>`;
  const status = view.state === 'approve' ? '<p class="arc-access-status" id="cli-status" role="status"></p>' : '';
  const page = accessDocument({ locale, title: 'page.cli', ...(script ? { script } : {}),
    body: accessPanel({ state: 'cli', view: card, host: new URL(origin).host, actions, extra: note, after: status }) });
  return new Response(page.html, { status: view.state === 'unavailable' ? 410 : 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; img-src 'self'; style-src 'sha256-${page.styleHash}'; ${script ? `script-src 'sha256-${page.scriptHash}'; connect-src 'self'; ` : ''}base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
  } });
}
