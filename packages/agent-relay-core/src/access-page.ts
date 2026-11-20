/**
 * The access pages: the page's own sign-in entry (the Lab's AccessPage) and the Relay's callback, failure and command-line pages.
 * Words for both locales, which page shows what (`accessPlan`, a pure rule with a vector table), the style and the mark, all as
 * strings: these pages load before the app and stay small, so this module imports nothing.
 */
export const signInReturnKey = 'agent-remote-sign-in-return';

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
    'cli.approve.title': 'Allow command line access?',
    'cli.approve.description': '{label} asks to act as you in Orchard: read and drive your sessions, windows and computers. Allow it only if you started this sign-in.',
    'cli.approve.code': 'Code {code}: check that your terminal shows the same.',
    'cli.approve.allow': 'Allow',
    'cli.approve.refuse': 'Refuse',
    'cli.saving': 'Saving…',
    'cli.allowed': 'Allowed. Return to your terminal.',
    'cli.refused': 'Refused. You can close this page.',
    'cli.failed': 'This could not be saved. Start again from your terminal.',
    'cli.signin.title': 'Sign in first',
    'cli.signin.description': 'Sign in to Orchard in this browser, then open the link from your terminal again.',
    'cli.reauthenticate.title': 'Sign in again',
    'cli.reauthenticate.description': 'Allowing command line access needs a recent sign-in. Sign in again, then open the link from your terminal again.',
    'cli.unavailable.title': 'This sign-in is not available',
    'cli.unavailable.description': 'It expired or was already answered. Start again from your terminal with agent-remote-controller login.',
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
    'cli.approve.title': '允许命令行访问吗？',
    'cli.approve.description': '{label} 想以你的身份使用 Orchard：查看和操作你的会话、窗口和电脑。只有这次登录是你自己发起的，才允许它。',
    'cli.approve.code': '代码 {code}：确认终端里显示的一样。',
    'cli.approve.allow': '允许',
    'cli.approve.refuse': '拒绝',
    'cli.saving': '正在保存…',
    'cli.allowed': '已允许，回到终端吧。',
    'cli.refused': '已拒绝，可以关掉这个页面了。',
    'cli.failed': '没能保存，请在终端里重新开始。',
    'cli.signin.title': '先登录',
    'cli.signin.description': '先在这个浏览器里登录 Orchard，再从终端重新打开这个链接。',
    'cli.reauthenticate.title': '重新登录',
    'cli.reauthenticate.description': '允许命令行访问需要刚刚登录过。请重新登录，再从终端打开这个链接。',
    'cli.unavailable.title': '这次登录已经不可用了',
    'cli.unavailable.description': '它过期了，或者已经处理过。请在终端里用 agent-remote-controller login 重新开始。',
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
export const accessBrandMark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 9h18M9 9v12"/></svg>';
export const accessCopy = {
  checking: { title: 'Opening your session', description: 'Checking whether you are already signed in.', status: 'Checking access…' },
  signin: { title: 'Sign in to continue', description: 'Sign in with an account approved for this site. We will bring you straight back to this session.', status: '' },
  restoring: { title: 'Reconnecting securely', description: 'Your conversation will return as soon as access is restored.', status: 'Restoring access…' },
  verifying: { title: 'Completing sign-in', description: 'Confirming your access before opening your conversation.', status: 'Verifying access…' },
  opening: { title: 'You are signed in', description: 'Taking you back to your conversation.', status: 'Opening session…' },
  expired: { title: 'Let’s try signing in again', description: 'This sign-in has expired or is no longer valid. Start again in this browser.', status: '' },
  unavailable: { title: 'Connection interrupted', description: 'We could not reach the service. Check your connection and try again.', status: '' },
} as const;
export type AccessPageState = keyof typeof accessCopy;

export const accessPageStyle = `
.arc-access {
  --entry-bg: var(--obs-canvas, oklch(0.975 0.006 255.5));
  --entry-surface: var(--obs-surface, oklch(0.993 0.003 247.9));
  --entry-text: var(--obs-text, oklch(0.243 0.024 248.8));
  --entry-muted: var(--obs-text-secondary, oklch(0.485 0.029 246.6));
  --entry-line: var(--obs-border, oklch(0.909 0.016 248));
  --entry-action: var(--obs-action, oklch(0.533 0.137 250.7));
  box-sizing: border-box; min-height: 100svh; width: 100%; margin: 0;
  display: grid; grid-template-rows: auto 1fr auto;
  padding: max(28px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
  background: var(--entry-bg); color: var(--entry-text);
  font: 400 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.arc-access *, .arc-access *::before, .arc-access *::after { box-sizing: border-box; }
.arc-access [hidden] { display: none !important; }
.arc-access-brand { display: flex; align-items: center; gap: 10px; width: min(100%, 1040px); margin-inline: auto; font-weight: 650; letter-spacing: -.02em; }
.arc-access-brand svg { width: 26px; height: 26px; color: var(--entry-action); }
.arc-access-body { width: min(100%, 424px); margin: auto; padding-block: 56px 72px; }
.arc-access-progress { display: flex; list-style: none; padding: 0; margin: 0 0 44px; gap: 16px; }
.arc-access-progress li { flex: 1; border-top: 2px solid var(--entry-line); padding-top: 10px; color: var(--entry-muted); font-size: 12px; }
.arc-access-progress li[aria-current="step"] { color: var(--entry-action); border-color: var(--entry-action); font-weight: 650; }
.arc-access-progress span { margin-right: 7px; font-variant-numeric: tabular-nums; }
.arc-access-eyebrow { color: var(--entry-muted); margin: 0 0 12px; font-size: 11px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
.arc-access h1 { font-size: 30px; line-height: 1.2; font-weight: 650; letter-spacing: -.035em; margin: 0 0 16px; text-wrap: balance; }
.arc-access h1:focus { outline: none; }
.arc-access-description { color: var(--entry-muted); font-size: 16px; margin: 0; line-height: 1.65; max-width: 40ch; }
.arc-access-activity { display: flex; align-items: center; gap: 10px; margin-top: 32px; color: var(--entry-muted); font-size: 13px; }
.arc-access-activity::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--entry-action); animation: arc-access-pulse 1.6s ease-in-out infinite; }
.arc-access-actions { display: grid; gap: 12px; margin-top: 32px; }
.arc-access-action { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-height: 48px; border: 1px solid var(--entry-action); border-radius: 8px; padding: 12px 18px; background: var(--entry-action); color: var(--entry-surface); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; transition: background-color 180ms ease-out; }
.arc-access .arc-access-action:hover { background: color-mix(in oklch, var(--entry-action) 88%, var(--entry-text)); color: var(--entry-surface); }
.arc-access-action:focus-visible, .arc-access-secondary:focus-visible { outline: 2px solid var(--entry-action); outline-offset: 4px; }
.arc-access .arc-access-secondary { display: flex; justify-content: center; align-items: center; min-height: 44px; padding: 8px; color: var(--entry-muted); background: transparent; border: 0; font: inherit; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
.arc-access-note { color: var(--entry-muted); font-size: 12px; line-height: 1.6; margin: 18px 0 0; }
.arc-access-footer { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; width: min(100%, 1040px); margin-inline: auto; padding-top: 18px; border-top: 1px solid var(--entry-line); color: var(--entry-muted); font-size: 12px; }
.arc-access-host { overflow-wrap: anywhere; }
.arc-access[data-state="expired"] .arc-access-eyebrow, .arc-access[data-state="unavailable"] .arc-access-eyebrow { color: var(--obs-warning, oklch(0.532 0.113 62)); }
@keyframes arc-access-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .arc-access-activity::before { animation: none; } .arc-access-action { transition: none; } }
@media (max-width: 600px) {
  .arc-access { padding-inline: max(24px, env(safe-area-inset-left)) max(24px, env(safe-area-inset-right)); }
  .arc-access-body { padding-block: 48px 64px; }
  .arc-access-progress { margin-bottom: 36px; gap: 12px; }
  .arc-access h1 { font-size: 28px; }
}
@media (max-height: 540px) { .arc-access-body { padding-block: 24px 32px; } .arc-access-progress { margin-bottom: 24px; } }
`;
