import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { signInReturnKey } from './access-page.js';
import { authenticationCallback } from './auth-callback.js';

/** An element of the page as its script sees it: the text, the attributes and the focus it sets. */
function element() {
  const attributes = new Map<string, string>();
  return { textContent: '', href: '', dataset: {} as Record<string, string>, focused: false,
    setAttribute: (name: string, value: string) => { attributes.set(name, value); }, attribute: (name: string) => attributes.get(name),
    focus() { this.focused = true; } };
}
type Responder = (request: { url: string; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; body?: unknown }>;

/** Runs the callback page's own script as a browser would, against stubs for the device, the address and the Relay's answer. */
async function openCallback(options: { hash?: string; saved?: string; language?: string; acceptLanguage?: string; respond?: Responder } = {}) {
  const html = await authenticationCallback('https://relay.example', options.acceptLanguage).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const page = element(), status = element(), title = element(), description = element(), retry = element(), back = element();
  const byId: Record<string, ReturnType<typeof element>> = { 'access-status': status, 'access-title': title, 'access-description': description, 'access-retry': retry, 'access-back': back };
  const document = { documentElement: { lang: '' }, title: '', querySelector: (selector: string) => selector === '.arc-access' ? page : undefined, getElementById: (id: string) => byId[id] };
  const storage = (values: Record<string, string | undefined>) => ({ getItem: (key: string) => values[key] ?? null, removeItem: (key: string) => { delete values[key]; } });
  const session: Record<string, string | undefined> = options.saved ? { [signInReturnKey]: options.saved } : {};
  const replaced: string[] = [], history: string[] = [], requests: string[] = [], timers: Array<() => void> = [];
  const fetch = (url: string, init: { body: string; signal: AbortSignal }) => {
    requests.push(init.body);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      options.respond?.({ url, body: init.body, signal: init.signal }).then(answer => resolve({ ok: answer.ok, status: answer.status, json: async () => answer.body }), reject);
    });
  };
  runInNewContext(script, { document, URLSearchParams, AbortController, Error, JSON, encodeURIComponent, location: { hash: options.hash ?? '', replace: (path: string) => replaced.push(path) },
    history: { replaceState: (_state: unknown, _title: string, url: string) => history.push(url) }, fetch,
    localStorage: storage({ 'agent-remote:language': options.language }), sessionStorage: storage(session),
    setTimeout: (callback: () => void) => timers.push(callback), clearTimeout: () => {} });
  const settle = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
  await settle();
  return { document, page, status, title, description, retry, back, replaced, history, requests, session, settle, deadline: () => timers[0]!() };
}
const signedIn = (body: unknown) => async () => ({ ok: true, status: 200, body });
const refused = (status: number) => async () => ({ ok: false, status, body: {} });

describe('the script of the callback page', () => {
  it('says it is signing in, removes the ticket from the address bar, and opens the path the Relay returns', async () => {
    const page = await openCallback({ hash: '#ticket=signed', saved: '/?host=a', respond: signedIn({ returnPath: '/?host=a&provider=codex&session=s' }) });
    expect(page.requests).toEqual([JSON.stringify({ ticket: 'signed' })]);
    expect(page.history).toEqual(['/auth/callback']);
    expect(page.replaced).toEqual(['/?host=a&provider=codex&session=s']);
    expect(page.status.textContent).toBe('Signed in. Opening your conversation…');
    expect(page.session[signInReturnKey]).toBeUndefined();
  });

  it('waits with the sign-in sentence until the Relay answers', async () => {
    const page = await openCallback({ hash: '#ticket=signed', respond: () => new Promise(() => {}) });
    expect(page.status.textContent).toBe('Signing you in…');
    expect(page.replaced).toEqual([]);
  });

  it('asks to sign in again, without a request, when there is no ticket', async () => {
    const page = await openCallback();
    expect(page.requests).toEqual([]);
    expect(page.page.dataset.kind).toBe('card');
    expect(page.title.textContent).toBe('Let’s sign in again');
    expect(page.title.focused).toBe(true);
    expect(page.description.attribute('role')).toBe('alert');
    expect(page.retry.textContent).toBe('Sign in again');
    expect(page.retry.href).toBe('/auth/login');
    expect(page.back.textContent).toBe('Back to Orchard');
  });

  it.each([[401, 'Let’s sign in again'], [403, 'Let’s sign in again'], [503, 'Can’t reach Orchard right now']])('answers %i with the card "%s" and no redirect', async (status, heading) => {
    const page = await openCallback({ hash: '#ticket=signed', respond: refused(status) });
    expect(page.title.textContent).toBe(heading);
    expect(page.title.focused).toBe(true);
    expect(page.replaced).toEqual([]);
  });

  it('reports the Relay as unreachable when the request fails or takes more than 12 seconds', async () => {
    const failed = await openCallback({ hash: '#ticket=signed', respond: () => Promise.reject(new Error('offline')) });
    expect(failed.title.textContent).toBe('Can’t reach Orchard right now');
    const hung = await openCallback({ hash: '#ticket=signed', respond: () => new Promise(() => {}) });
    hung.deadline(); await hung.settle();
    expect(hung.title.textContent).toBe('Can’t reach Orchard right now');
    expect(hung.replaced).toEqual([]);
  });

  it.each(['//untrusted.example', 'https://untrusted.example/?host=a', '/elsewhere?host=a', '/\\untrusted.example'])('never redirects to the return path %j', async returnPath => {
    const page = await openCallback({ hash: '#ticket=signed', respond: signedIn({ returnPath }) });
    expect(page.replaced).toEqual([]);
    expect(page.title.textContent).toBe('Can’t reach Orchard right now');
  });

  it('opens the controller root with the Host when the Relay names only a Host', async () => {
    const page = await openCallback({ hash: '#ticket=signed', respond: signedIn({ hostId: 'a b' }) });
    expect(page.replaced).toEqual(['/?host=a%20b']);
  });

  it('keeps only a session link of this site as the way back to sign in again', async () => {
    expect((await openCallback({ saved: '/?host=a&provider=codex&session=s' })).retry.href).toBe('/auth/login?host=a&provider=codex&session=s');
    for (const saved of ['//untrusted.example', 'https://untrusted.example', '/elsewhere?host=a', `/?${'a'.repeat(32_768)}`]) expect((await openCallback({ saved })).retry.href, saved.slice(0, 30)).toBe('/auth/login');
  });

  it('speaks the language of the request, and the device\'s own choice wins over it', async () => {
    const zh = await openCallback({ acceptLanguage: 'zh-CN,en;q=0.8' });
    expect([zh.document.documentElement.lang, zh.document.title, zh.title.textContent, zh.retry.textContent, zh.back.textContent]).toEqual(['zh-CN', '登录 · Orchard', '再登录一次吧', '重新登录', '回到 Orchard']);
    const chosenEnglish = await openCallback({ acceptLanguage: 'zh-CN', language: 'en' });
    expect([chosenEnglish.document.documentElement.lang, chosenEnglish.title.textContent]).toEqual(['en', 'Let’s sign in again']);
    const chosenChinese = await openCallback({ acceptLanguage: 'en-US', language: 'zh' });
    expect([chosenChinese.document.documentElement.lang, chosenChinese.title.textContent]).toEqual(['zh-CN', '再登录一次吧']);
    const unknownChoice = await openCallback({ acceptLanguage: 'zh-CN', language: 'fr' });
    expect(unknownChoice.title.textContent).toBe('再登录一次吧');
  });
});
