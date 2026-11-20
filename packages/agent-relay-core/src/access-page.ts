/**
 * The access pages: the page's own sign-in entry (the Lab's AccessPage) and the Relay's callback, failure and command-line pages.
 * Words for both locales, which page shows what (`accessPlan`, a pure rule with a vector table), the style and the mark, all as
 * strings: these pages load before the app and stay small, so this module imports nothing.
 */
export const signInReturnKey = 'agent-remote-sign-in-return';
/** Where the device keeps its language choice (`zh` or `en`); a test keeps it equal to the client's key. */
export const accessLanguageKey = 'agent-remote:language';

export type AccessLocale = 'en' | 'zh';

/** The first language of an Accept-Language header or a browser's list that the pages speak; English otherwise. */
export function accessLocale(languages: string | readonly string[] | null | undefined): AccessLocale {
  const list = typeof languages === 'string' ? languages.split(',') : languages ?? [];
  for (const entry of list) {
    const [tag = '', ...parameters] = entry.split(';');
    if (parameters.some(parameter => /^\s*q\s*=\s*0(\.0*)?\s*$/.test(parameter))) continue;
    const primary = tag.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'zh') return 'zh';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

const accessWords = {
  en: {
    brand: 'Orchard',
    'page.signIn': 'Sign in · Orchard',
    'page.cli': 'Command line access · Orchard',
    'wait.checking': 'Opening Orchard…',
    'wait.checkingSession': 'Opening your conversation…',
    'wait.verifying': 'Signing you in…',
    'wait.opening': 'Signed in. Opening Orchard…',
    'wait.openingSession': 'Signed in. Opening your conversation…',
    'signin.title': 'Sign in to Orchard',
    'signin.description': 'Use an account approved for this site.',
    'signin.titleSession': 'Sign in to continue',
    'signin.descriptionSession': 'After you sign in, this link opens the same conversation. Use the account its computer belongs to, or one it is shared with.',
    'expired.title': 'Let’s sign in again',
    'expired.description': 'This sign-in expired or is no longer valid. Start again in this browser.',
    'expired.denied': 'This sign-in expired, was cancelled, or the account is not approved for this site. Sign in again with an approved account.',
    'unavailable.title': 'Can’t reach Orchard right now',
    'unavailable.description': 'Check your connection and try again.',
    'unavailable.capacity': 'This site has reached its account capacity. Contact the site operator before trying again.',
    'action.signIn': 'Sign in',
    'action.signInAgain': 'Sign in again',
    'action.tryAgain': 'Try again',
    'action.back': 'Back to Orchard',
    noscript: 'JavaScript is required to finish signing in. Turn it on, then sign in again.',
  },
  zh: {
    brand: 'Orchard',
    'page.signIn': '登录 · Orchard',
    'page.cli': '命令行访问 · Orchard',
    'wait.checking': '正在打开 Orchard…',
    'wait.checkingSession': '正在打开这段对话…',
    'wait.verifying': '正在登录…',
    'wait.opening': '登录好了，正在打开 Orchard…',
    'wait.openingSession': '登录好了，正在打开这段对话…',
    'signin.title': '登录 Orchard',
    'signin.description': '请用这个站点允许的账号登录。',
    'signin.titleSession': '登录后继续',
    'signin.descriptionSession': '登录之后，这个链接会打开同一段对话。请用这台电脑所属的账号，或者它分享给你的账号。',
    'expired.title': '再登录一次吧',
    'expired.description': '这次登录过期了，或者已经失效。请在这个浏览器里重新开始。',
    'expired.denied': '这次登录过期、被取消了，或者这个账号没有被允许。请用被允许的账号重新登录。',
    'unavailable.title': '暂时连不上 Orchard',
    'unavailable.description': '检查一下网络，再试一次。',
    'unavailable.capacity': '这个站点的账号已经满了，请先联系站点管理员。',
    'action.signIn': '登录',
    'action.signInAgain': '重新登录',
    'action.tryAgain': '再试一次',
    'action.back': '回到 Orchard',
    noscript: '需要打开 JavaScript 才能完成登录。打开之后，请重新登录。',
  },
} as const satisfies Record<AccessLocale, Record<string, string>>;
export type AccessWordKey = keyof typeof accessWords.en;

/** Every word of the access pages in a locale, for the pages' scripts and checks. */
export function accessWordsOf(locale: AccessLocale): Readonly<Record<AccessWordKey, string>> {
  return accessWords[locale];
}

/** A word of the access pages, with `{name}` placeholders filled. */
export function accessWord(locale: AccessLocale, key: AccessWordKey, params: Readonly<Record<string, string>> = {}): string {
  return accessWords[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}

export type AccessPageState = 'checking' | 'signin' | 'verifying' | 'opening' | 'expired' | 'unavailable';
/** The page's own entry, or a page the Relay serves; they differ only in a failure's way out. */
export type AccessSurface = 'app' | 'relay';
export interface AccessFacts { readonly sessionLink?: boolean; readonly failure?: 'denied' | 'capacity'; readonly surface?: AccessSurface }

/** What a state shows, as words of the table: a quiet wait (the mark and one sentence) or a card that needs the reader. */
export type AccessPlan = { readonly kind: 'wait'; readonly sentence: AccessWordKey }
  | { readonly kind: 'card'; readonly title: AccessWordKey; readonly description: AccessWordKey; readonly action: AccessWordKey; readonly secondary?: AccessWordKey };

export function accessPlan(state: AccessPageState, { sessionLink = false, failure, surface = 'app' }: AccessFacts = {}): AccessPlan {
  switch (state) {
    case 'checking': return { kind: 'wait', sentence: sessionLink ? 'wait.checkingSession' : 'wait.checking' };
    case 'verifying': return { kind: 'wait', sentence: 'wait.verifying' };
    case 'opening': return { kind: 'wait', sentence: sessionLink ? 'wait.openingSession' : 'wait.opening' };
    case 'signin': return { kind: 'card', title: sessionLink ? 'signin.titleSession' : 'signin.title', description: sessionLink ? 'signin.descriptionSession' : 'signin.description', action: 'action.signIn' };
    case 'expired': return { kind: 'card', title: 'expired.title', description: failure === 'denied' ? 'expired.denied' : 'expired.description', action: 'action.signInAgain', ...(surface === 'relay' ? { secondary: 'action.back' as const } : {}) };
    case 'unavailable': return { kind: 'card', title: 'unavailable.title', description: failure === 'capacity' ? 'unavailable.capacity' : 'unavailable.description',
      ...(surface === 'app' ? { action: 'action.tryAgain' as const, secondary: 'action.signIn' as const } : { action: 'action.signInAgain' as const, secondary: 'action.back' as const }) };
  }
}

export type AccessView = { readonly kind: 'wait'; readonly sentence: string }
  | { readonly kind: 'card'; readonly title: string; readonly description: string; readonly action: string; readonly secondary?: string };

/** A state's words in a locale. */
export function accessView(state: AccessPageState, locale: AccessLocale, facts: AccessFacts = {}): AccessView {
  const plan = accessPlan(state, facts);
  const word = (key: AccessWordKey) => accessWords[locale][key];
  return plan.kind === 'wait' ? { kind: 'wait', sentence: word(plan.sentence) }
    : { kind: 'card', title: word(plan.title), description: word(plan.description), action: word(plan.action), ...(plan.secondary ? { secondary: word(plan.secondary) } : {}) };
}

/** A wait shows nothing for this long, so a quick check paints only the ground; then its mark and sentence fade in. */
export const accessWaitDelayMs = 400;
/** The Orchard mark, the drawing of `markSvg()` in agent-client-web (a test keeps them equal); the clip has an id of its own. */
export const accessMark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><defs><clipPath id="arc-tile"><rect width="64" height="64" rx="15"/></clipPath></defs><g clip-path="url(#arc-tile)"><rect width="64" height="64" fill="#24242a"/><g transform="rotate(-14 32 44)"><path d="M33 20c0-4 1-7 4-9" stroke="#2f8f55" stroke-width="3.2" stroke-linecap="round" fill="none"/><path d="M37 11.5c2-7 10-9 15-6-2 6-10 8-15 6z" fill="#4cc27a"/><path d="M33 19c-17 0-29 12-29 28 0 10 4 19 8 24h42c4-5 8-14 8-24 0-16-12-28-29-28z" fill="#ff7f45"/><ellipse cx="25" cy="35" rx="3.9" ry="6" fill="#16161a"/><ellipse cx="36" cy="35" rx="3.9" ry="6" fill="#16161a"/></g></g></svg>';
export const accessWordmark = 'orchard';

/**
 * The pages' style: Orchard colours as light-dark() pairs (the page follows the system or the root's colour-scheme), one surface card
 * on the ground, pill buttons. A wait paints only the ground for the delay, then fades its mark and sentence in.
 */
export const accessPageStyle = `
:root{color-scheme:light dark}
body{margin:0}
.arc-access{--arc-ground:light-dark(#f3efe9,#151517);--arc-surface:light-dark(#ffffff,#232327);--arc-fill:light-dark(#f4f4f6,#2f2f34);--arc-text:light-dark(#2a2b30,#dcdde2);--arc-strong:light-dark(#1d1d1f,#f2f2f5);--arc-secondary:light-dark(#696d75,#9a9da4);--arc-brand:light-dark(#ff7f45,#ff7f45);--arc-on-brand:light-dark(#1d1d1f,#1d1d1f);--arc-focus:light-dark(#d9581c,#ff7f45);--arc-danger:light-dark(#c4321f,#ff7a6b);--arc-separator:light-dark(rgb(0 0 0 / 0.06),rgb(255 255 255 / 0.07));
  box-sizing:border-box;min-height:100svh;width:100%;display:grid;place-items:center;padding:max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));
  background:var(--arc-ground);color:var(--arc-text);font:400 14.5px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
.arc-access *,.arc-access *::before,.arc-access *::after{box-sizing:border-box}
.arc-access [hidden]{display:none!important}
.arc-access-panel{display:grid;justify-items:center;gap:16px;width:min(100%,400px);text-align:center}
.arc-access[data-kind="card"] .arc-access-panel{justify-items:stretch;gap:0;padding:28px;border-radius:22px;background:var(--arc-surface);text-align:left}
.arc-access-brand{display:flex;align-items:center;gap:10px}
.arc-access[data-kind="card"] .arc-access-brand{margin-bottom:22px}
.arc-access-mark{display:block;width:56px;height:56px;flex:none}
.arc-access[data-kind="card"] .arc-access-mark{width:28px;height:28px}
.arc-access-mark svg{display:block;width:100%;height:100%}
.arc-access-wordmark{font:750 20px/1 ui-rounded,"SF Pro Rounded",-apple-system,system-ui,sans-serif;letter-spacing:-.02em;color:var(--arc-strong)}
.arc-access[data-kind="wait"] .arc-access-wordmark,.arc-access[data-kind="wait"] .arc-access-detail,.arc-access[data-kind="card"] .arc-access-sentence{display:none}
.arc-access-sentence{margin:0;color:var(--arc-secondary)}
.arc-access[data-kind="wait"] .arc-access-mark,.arc-access[data-kind="wait"] .arc-access-sentence{animation:arc-access-in 240ms ease-out ${accessWaitDelayMs}ms both}
.arc-access h1{margin:0 0 8px;font:650 22px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;letter-spacing:-.02em;color:var(--arc-strong);text-wrap:balance}
.arc-access h1:focus{outline:none}
.arc-access-description{margin:0;color:var(--arc-secondary)}
.arc-access-note{margin:14px 0 0;color:var(--arc-secondary);font-size:13px}
.arc-access-note strong{padding:1px 6px;border-radius:6px;background:var(--arc-fill);color:var(--arc-strong);font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em}
.arc-access-actions{display:grid;gap:6px;margin-top:24px}
.arc-access-action{display:flex;align-items:center;justify-content:center;width:100%;min-height:48px;padding:12px 20px;border:0;border-radius:999px;background:var(--arc-brand);color:var(--arc-on-brand);font:inherit;font-weight:600;font-size:15px;text-decoration:none;cursor:pointer}
.arc-access-action:hover{filter:brightness(.96)}
.arc-access .arc-access-secondary{display:flex;align-items:center;justify-content:center;min-height:44px;padding:8px;border:0;background:none;color:var(--arc-secondary);font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.arc-access-action:focus-visible,.arc-access-secondary:focus-visible{outline:2px solid var(--arc-focus);outline-offset:2px}
.arc-access-status{min-height:1.55em;margin:12px 0 0;color:var(--arc-secondary);font-size:13px}
.arc-access-footer{margin:24px 0 0;padding-top:14px;border-top:1px solid var(--arc-separator);color:var(--arc-secondary);font-size:12px;overflow-wrap:anywhere}
@keyframes arc-access-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.arc-access[data-kind="wait"] .arc-access-mark,.arc-access[data-kind="wait"] .arc-access-sentence{animation-duration:.01ms}}
:root[data-motion="reduce"] .arc-access[data-kind="wait"] .arc-access-mark,:root[data-motion="reduce"] .arc-access[data-kind="wait"] .arc-access-sentence{animation-duration:.01ms}
@media (max-width:600px){.arc-access[data-kind="card"] .arc-access-panel{padding:24px}}
`;
