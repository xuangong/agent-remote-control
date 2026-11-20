import type { AccessFacts, AccessPageState, AccessPlan } from './access-page.js';

/** Which words each access state shows, for each kind of page and link: the rows `accessPlan` must give. */
export const ACCESS_PLAN_VECTORS: readonly { readonly state: AccessPageState; readonly facts: AccessFacts; readonly plan: AccessPlan }[] = [
  { state: 'checking', facts: {}, plan: { kind: 'wait', sentence: 'wait.checking' } },
  { state: 'checking', facts: { sessionLink: true }, plan: { kind: 'wait', sentence: 'wait.checkingSession' } },
  { state: 'verifying', facts: { surface: 'relay' }, plan: { kind: 'wait', sentence: 'wait.verifying' } },
  { state: 'opening', facts: { surface: 'relay' }, plan: { kind: 'wait', sentence: 'wait.opening' } },
  { state: 'opening', facts: { surface: 'relay', sessionLink: true }, plan: { kind: 'wait', sentence: 'wait.openingSession' } },
  { state: 'signin', facts: {}, plan: { kind: 'card', title: 'signin.title', description: 'signin.description', action: 'action.signIn' } },
  { state: 'signin', facts: { sessionLink: true }, plan: { kind: 'card', title: 'signin.titleSession', description: 'signin.descriptionSession', action: 'action.signIn' } },
  { state: 'expired', facts: { surface: 'relay' }, plan: { kind: 'card', title: 'expired.title', description: 'expired.description', action: 'action.signInAgain', secondary: 'action.back' } },
  { state: 'expired', facts: { surface: 'relay', failure: 'denied' }, plan: { kind: 'card', title: 'expired.title', description: 'expired.denied', action: 'action.signInAgain', secondary: 'action.back' } },
  { state: 'expired', facts: {}, plan: { kind: 'card', title: 'expired.title', description: 'expired.description', action: 'action.signInAgain' } },
  { state: 'unavailable', facts: {}, plan: { kind: 'card', title: 'unavailable.title', description: 'unavailable.description', action: 'action.tryAgain', secondary: 'action.signIn' } },
  { state: 'unavailable', facts: { surface: 'relay' }, plan: { kind: 'card', title: 'unavailable.title', description: 'unavailable.description', action: 'action.signInAgain', secondary: 'action.back' } },
  { state: 'unavailable', facts: { surface: 'relay', failure: 'capacity' }, plan: { kind: 'card', title: 'unavailable.title', description: 'unavailable.capacity', action: 'action.signInAgain', secondary: 'action.back' } },
];

/** Accept-Language headers and browser lists, and the locale the pages speak for them. */
export const ACCESS_LOCALE_VECTORS: readonly [string | readonly string[] | null, 'en' | 'zh'][] = [
  ['zh-CN,zh;q=0.9,en;q=0.8', 'zh'], ['en-US,en;q=0.9,zh-CN;q=0.8', 'en'], ['fr-FR, zh-TW;q=0.5', 'zh'], ['zh;q=0, en', 'en'],
  ['de-DE', 'en'], ['', 'en'], [null, 'en'], [['zh-Hans-CN', 'en'], 'zh'], [['en-GB'], 'en'], [['ZH_hk'], 'zh'], [[], 'en'],
];
