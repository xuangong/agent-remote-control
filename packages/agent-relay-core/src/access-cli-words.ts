import type { AccessLocale } from './access-page.js';

/** The words of the command line sign-in page, in both languages; only the Relay's page carries them, not the app's entry. */
const cliWords = {
  en: {
    'approve.title': 'Allow command line access?',
    'approve.description': '{label} asks to act as you in Orchard: read and drive your sessions, windows and computers. Allow it only if you started this sign-in.',
    'approve.code': 'Code {code}: check that your terminal shows the same.',
    'approve.allow': 'Allow',
    'approve.refuse': 'Refuse',
    'saving': 'Saving…',
    'allowed': 'Allowed. Return to your terminal.',
    'refused': 'Refused. You can close this page.',
    'failed': 'This could not be saved. Start again from your terminal.',
    'signin.title': 'Sign in first',
    'signin.description': 'Sign in to Orchard in this browser, then open the link from your terminal again.',
    'reauthenticate.title': 'Sign in again',
    'reauthenticate.description': 'Allowing command line access needs a recent sign-in. Sign in again, then open the link from your terminal again.',
    'unavailable.title': 'This sign-in is not available',
    'unavailable.description': 'It expired or was already answered. Start again from your terminal with agent-remote-controller login.',
  },
  zh: {
    'approve.title': '允许命令行访问吗？',
    'approve.description': '{label} 想以你的身份使用 Orchard：查看和操作你的会话、窗口和电脑。只有这次登录是你自己发起的，才允许它。',
    'approve.code': '代码 {code}：确认终端里显示的一样。',
    'approve.allow': '允许',
    'approve.refuse': '拒绝',
    'saving': '正在保存…',
    'allowed': '已允许，回到终端吧。',
    'refused': '已拒绝，可以关掉这个页面了。',
    'failed': '没能保存，请在终端里重新开始。',
    'signin.title': '先登录',
    'signin.description': '先在这个浏览器里登录 Orchard，再从终端重新打开这个链接。',
    'reauthenticate.title': '重新登录',
    'reauthenticate.description': '允许命令行访问需要刚刚登录过。请重新登录，再从终端打开这个链接。',
    'unavailable.title': '这次登录已经不可用了',
    'unavailable.description': '它过期了，或者已经处理过。请在终端里用 agent-remote-controller login 重新开始。',
  },
} as const satisfies Record<AccessLocale, Record<string, string>>;
export type CliWordKey = keyof typeof cliWords.en;

/** Every word of the command line page in a locale. */
export function cliWordsOf(locale: AccessLocale): Readonly<Record<CliWordKey, string>> {
  return cliWords[locale];
}

/** A word of the command line page, with `{name}` placeholders filled. */
export function cliWord(locale: AccessLocale, key: CliWordKey, params: Readonly<Record<string, string>> = {}): string {
  return cliWords[locale][key].replace(/\{(\w+)\}/g, (whole, name: string) => params[name] ?? whole);
}
