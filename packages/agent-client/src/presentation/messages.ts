/**
 * The message catalogue: every word the assistant view says, in English and Chinese. The locale follows the browser's
 * language (`chooseLocale`), English is the fallback. Pure: no DOM, clock or storage; a host reads the browser's languages
 * and passes them in.
 *
 * A message is a string with `{name}` placeholders, or plural forms keyed by the locale's plural category of `count`.
 * English has `one` and `other`; Chinese has only `other`. The Chinese words are the design's voice, not a translation
 * of the English sentence by sentence.
 */

export type Locale = 'en' | 'zh';
export const LOCALES: readonly Locale[] = ['en', 'zh'];

export type PluralCategory = 'one' | 'other';
export type Message = string | { readonly one?: string; readonly other: string };
export type MessageParams = Readonly<Record<string, string | number>>;

/** The plural category of a count in a locale (CLDR rules for integers). */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return locale === 'en' && count === 1 ? 'one' : 'other';
}

const en = {
  // The process modes and where they are chosen.
  'process.concise': 'Concise',
  'process.process': 'Process',
  'process.full': 'Full',
  'process.heading': 'Process',
  'process.assistant': 'This assistant',
  'process.device': 'All assistants on this device',
  'process.letters': 'Show letters',
  'process.options': 'View options',

  // The work line of a turn: at most three clauses, joined, the first capitalised.
  'work.readFile': 'read {file}',
  'work.readFiles': { one: 'read {count} file', other: 'read {count} files' },
  'work.editFile': 'edited {file}',
  'work.editFiles': { one: 'edited {count} file', other: 'edited {count} files' },
  'work.writeFile': 'wrote {file}',
  'work.writeFiles': { one: 'wrote {count} file', other: 'wrote {count} files' },
  'work.commands': { one: 'ran a command', other: 'ran {count} commands' },
  'work.searches': { one: 'searched once', other: 'searched {count} times' },
  'work.fetches': { one: 'opened a web page', other: 'opened {count} web pages' },
  'work.tools': { one: 'used a tool', other: 'used {count} tools' },
  'work.reasoning': 'thought it through',
  'work.todo': 'updated the plan',
  'work.compaction': 'tidied up the context',
  'work.background': { one: 'ran a background check', other: 'ran {count} background checks' },
  'work.steps': { one: '{count} step', other: '{count} steps' },
  'work.more': { one: 'and {count} more', other: 'and {count} more' },
  'work.separator': ', ',
  'work.failed': { one: '{count} step failed', other: '{count} steps failed' },
  'work.toggle': 'Show the steps of this turn',

  // The live line of a running turn.
  'status.working': '{name} is working',
  'status.thinking': '{name} is thinking',
  'status.tests': '{name} is running tests',
  'status.command': '{name} is running a command',
  'status.reading': '{name} is reading {file}',
  'status.editing': '{name} is editing {file}',
  'status.writing': '{name} is writing {file}',
  'status.searching': '{name} is searching',
  'status.fetching': '{name} is reading a web page',
  'status.tool': '{name} is using {tool}',
  'status.planning': '{name} is planning',
  'status.compacting': '{name} is tidying up the context',
  'status.background': '{name} is running a background check',
  'status.replying': '{name} is writing a reply',
  'status.detail': 'working',
  'status.progress': '{done} of {total} done',
  'time.seconds': '{seconds}s',
  'time.minutes': '{minutes}m {seconds}s',
  'time.hours': '{hours}h {minutes}m {seconds}s',

  // Inline approvals: plain choices, the rest one tap away.
  'approval.allow': 'Allow',
  'approval.notNow': 'Not now',
  'approval.showChanges': 'Show what changes',
  'approval.hideChanges': 'Hide what changes',
  'approval.runCommand': '{name} wants to run a command',
  'approval.readFile': '{name} wants to read {file}',
  'approval.editFile': '{name} wants to edit {file}',
  'approval.writeFile': '{name} wants to write {file}',
  'approval.search': '{name} wants to search',
  'approval.fetch': '{name} wants to open {url}',
  'approval.useTool': '{name} wants to use {tool}',
  'approval.permission': '{name} wants more access',
  'approval.plan': '{name} has a plan for you to review',
  'approval.question': '{name} has a question',
  'approval.form': '{name} needs a few details',
  'approval.external': '{name} needs you to finish something',

  // One-line receipts of answered interactions.
  'receipt.allowedOnce': 'Allowed once',
  'receipt.allowedSession': 'Allowed for this session',
  'receipt.ruleApplied': 'Rule applied',
  'receipt.denied': 'Not allowed',
  'receipt.canceled': 'Canceled',
  'receipt.planApproved': 'Plan approved',
  'receipt.planResumed': 'Plan approved, carrying on',
  'receipt.planRejected': 'Asked for changes to the plan',
  'receipt.answered': 'Answered',
  'receipt.partlyAnswered': 'Partly answered',
  'receipt.unanswered': 'No answers',
  'receipt.dismissed': 'Dismissed',
  'receipt.submitted': 'Submitted',
  'receipt.declined': 'Declined',
  'receipt.permissionTurn': 'Allowed for this turn',
  'receipt.permissionSession': 'Allowed for this session',
  'receipt.completed': 'Done',
  'receipt.mismatch': 'The recorded answer does not match its question',
  'receipt.questions': { one: '{count} question', other: '{count} questions' },
  'receipt.answeredOf': '{answered} of {total} answered',

  // The conversation around the bubbles.
  'conversation.assistant': 'Assistant',
  'conversation.sessionChange': 'Continued in a new session',
  'conversation.today': 'Today {time}',
  'conversation.yesterday': 'Yesterday {time}',
  'conversation.sending': 'Sending',
} as const satisfies Readonly<Record<string, Message>>;

export type MessageKey = keyof typeof en;

const zh: Readonly<Record<MessageKey, Message>> = {
  'process.concise': '简洁',
  'process.process': '过程',
  'process.full': '完整',
  'process.heading': '过程显示',
  'process.assistant': '这个助手',
  'process.device': '这台设备上的所有助手',
  'process.letters': '显示信件',
  'process.options': '显示选项',

  'work.readFile': '翻了 {file}',
  'work.readFiles': { other: '翻了 {count} 个文件' },
  'work.editFile': '改了 {file}',
  'work.editFiles': { other: '改了 {count} 个文件' },
  'work.writeFile': '写好了 {file}',
  'work.writeFiles': { other: '写好了 {count} 个文件' },
  'work.commands': { other: '跑了 {count} 条命令' },
  'work.searches': { other: '搜了 {count} 次' },
  'work.fetches': { other: '看了 {count} 个网页' },
  'work.tools': { other: '用了 {count} 个工具' },
  'work.reasoning': '想了想',
  'work.todo': '更新了计划',
  'work.compaction': '整理了上下文',
  'work.background': { other: '做了 {count} 次后台检查' },
  'work.steps': { other: '{count} 个步骤' },
  'work.more': { other: '还有 {count} 件事' },
  'work.separator': '，',
  'work.failed': { other: '{count} 步没成功' },
  'work.toggle': '看看这一轮做了什么',

  'status.working': '{name} 在忙',
  'status.thinking': '{name} 在琢磨',
  'status.tests': '{name} 在跑测试，稍等～',
  'status.command': '{name} 在跑命令',
  'status.reading': '{name} 在看 {file}',
  'status.editing': '{name} 在改 {file}',
  'status.writing': '{name} 在写 {file}',
  'status.searching': '{name} 在找东西',
  'status.fetching': '{name} 在看网页',
  'status.tool': '{name} 在用 {tool}',
  'status.planning': '{name} 在排计划',
  'status.compacting': '{name} 在整理上下文',
  'status.background': '{name} 在做后台检查',
  'status.replying': '{name} 在写回复',
  'status.detail': '认真工作中',
  'status.progress': '完成 {done}/{total}',
  'time.seconds': '{seconds} 秒',
  'time.minutes': '{minutes} 分 {seconds} 秒',
  'time.hours': '{hours} 小时 {minutes} 分 {seconds} 秒',

  'approval.allow': '好的',
  'approval.notNow': '先别',
  'approval.showChanges': '看看要改什么',
  'approval.hideChanges': '收起',
  'approval.runCommand': '{name} 想跑一条命令，可以吗？',
  'approval.readFile': '{name} 想看看 {file}，可以吗？',
  'approval.editFile': '{name} 想改一下 {file}，可以吗？',
  'approval.writeFile': '{name} 想写 {file}，可以吗？',
  'approval.search': '{name} 想搜一下，可以吗？',
  'approval.fetch': '{name} 想打开 {url}，可以吗？',
  'approval.useTool': '{name} 想用 {tool}，可以吗？',
  'approval.permission': '{name} 想要更多权限，可以吗？',
  'approval.plan': '{name} 写好了计划，你看看行不行',
  'approval.question': '{name} 想问你一件小事',
  'approval.form': '{name} 需要你填几项',
  'approval.external': '{name} 需要你去完成一步',

  'receipt.allowedOnce': '允许了这一次',
  'receipt.allowedSession': '这次会话都允许',
  'receipt.ruleApplied': '用了一条规则',
  'receipt.denied': '没有允许',
  'receipt.canceled': '取消了',
  'receipt.planApproved': '计划通过了',
  'receipt.planResumed': '计划通过了，接着做',
  'receipt.planRejected': '请它改一改计划',
  'receipt.answered': '回答了',
  'receipt.partlyAnswered': '答了一部分',
  'receipt.unanswered': '没有回答',
  'receipt.dismissed': '跳过了',
  'receipt.submitted': '提交了',
  'receipt.declined': '拒绝了',
  'receipt.permissionTurn': '这一轮允许了',
  'receipt.permissionSession': '这次会话都允许',
  'receipt.completed': '完成了',
  'receipt.mismatch': '记录的回答和问题对不上',
  'receipt.questions': { other: '{count} 个问题' },
  'receipt.answeredOf': '答了 {answered}/{total}',

  'conversation.assistant': '助手',
  'conversation.sessionChange': '换到新的会话继续',
  'conversation.today': '今天 {time}',
  'conversation.yesterday': '昨天 {time}',
  'conversation.sending': '发送中',
};

const catalogues: Readonly<Record<Locale, Readonly<Record<MessageKey, Message>>>> = { en, zh };

/** Every message of a locale, for the catalogue's own checks. */
export function messageCatalogue(locale: Locale): Readonly<Record<MessageKey, Message>> {
  return catalogues[locale];
}

/** The first of the reader's languages (most preferred first) that the catalogue speaks; English otherwise. */
export function chooseLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const primary = language.trim().toLowerCase().split(/[-_]/)[0];
    if (primary === 'zh') return 'zh';
    if (primary === 'en') return 'en';
  }
  return 'en';
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

/** The words of a locale: `t(key, params)` fills the placeholders and picks the plural form of `params.count`. */
export function translator(locale: Locale): Translate {
  const catalogue = catalogues[locale];
  return (key, params = {}) => {
    const message = catalogue[key] ?? en[key];
    const count = typeof params.count === 'number' ? params.count : undefined;
    const text = typeof message === 'string' ? message : (count !== undefined && message[pluralCategory(locale, count)]) || message.other;
    return text.replace(/\{(\w+)\}/g, (whole, name: string) => name in params ? String(params[name]) : whole);
  };
}

/** The placeholders a message uses in any of its forms, for the catalogue's own checks. */
export function messagePlaceholders(message: Message): readonly string[] {
  const forms = typeof message === 'string' ? [message] : Object.values(message);
  return [...new Set(forms.flatMap(form => [...(form ?? '').matchAll(/\{(\w+)\}/g)].map(match => match[1]!)))].sort();
}

/** Elapsed time in the locale's short words: "12s", "1m 05s", "1h 02m 05s". */
export function elapsedWords(seconds: number, t: Translate): string {
  const whole = Math.max(0, Math.floor(seconds));
  if (whole < 60) return t('time.seconds', { seconds: whole });
  const minutes = Math.floor(whole / 60), rest = String(whole % 60).padStart(2, '0');
  if (minutes < 60) return t('time.minutes', { minutes, seconds: rest });
  return t('time.hours', { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, '0'), seconds: rest });
}
