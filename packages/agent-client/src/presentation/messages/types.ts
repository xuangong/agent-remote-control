/** The shapes of the message catalogue, shared by the mechanism (../messages.ts) and the area tables. */
export type Locale = 'en' | 'zh';
export type PluralCategory = 'one' | 'other';
/** A string with `{name}` placeholders, or plural forms keyed by the locale's plural category of `count`. */
export type Message = string | { readonly one?: string; readonly other: string };
export type MessageParams = Readonly<Record<string, string | number>>;
/** A locale's words for one area: every key of the English area and no other, so the type check finds a missing one. */
export type AreaMessages<Area> = { readonly [K in keyof Area]: Message };
