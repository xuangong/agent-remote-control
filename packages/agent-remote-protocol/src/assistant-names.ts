/**
 * The name an assistant is called by, the same on every device and at the Relay, which names assistants in push reminders (I3c, the
 * coordinator's naming rule; I5c). A session's title is never the name.
 * - An assistant with a stored name (the owner gave it, or a first edit stored the generated one) is called by it.
 * - Any other assistant is called by a name from `ASSISTANT_NAME_IDS`, in the reader's language. Its key picks the name, so every device
 *   calls it the same; no other assistant of the account has that name in either language. Assistants without a name take their names
 *   in the order of their keys; when every name is taken they are numbered ("Dango 2").
 * The generated names are contract data: every client's catalogue has the same words under `name.<id>`, which its tests check.
 */
import { botViews, type WindowGroup } from './window-groups.js';

/** The default names, soft small things in the design's spirit. */
export const ASSISTANT_NAME_IDS = [
  'dango', 'gummies', 'nest', 'pebbles', 'hatch', 'mochi', 'bean', 'puff', 'sprout', 'pudding', 'acorn', 'bun', 'peach',
  'plum', 'button', 'marble', 'muffin', 'nori', 'tofu', 'biscuit', 'berry', 'cocoa', 'taro', 'cloud', 'pinecone',
] as const;
export type AssistantNameId = typeof ASSISTANT_NAME_IDS[number];
/** The languages an assistant is named in. */
export type AssistantNameLocale = 'en' | 'zh';

/** Each default name in each language. */
export const ASSISTANT_NAME_WORDS: Readonly<Record<AssistantNameId, Readonly<Record<AssistantNameLocale, string>>>> = {
  dango: { en: 'Dango', zh: '团团' }, gummies: { en: 'Gummies', zh: '软糖' }, nest: { en: 'Nest', zh: '窝' }, pebbles: { en: 'Pebbles', zh: '石子' },
  hatch: { en: 'Hatch', zh: '孵' }, mochi: { en: 'Mochi', zh: '麻薯' }, bean: { en: 'Bean', zh: '豆豆' }, puff: { en: 'Puff', zh: '泡芙' },
  sprout: { en: 'Sprout', zh: '芽芽' }, pudding: { en: 'Pudding', zh: '布丁' }, acorn: { en: 'Acorn', zh: '橡果' }, bun: { en: 'Bun', zh: '包子' },
  peach: { en: 'Peach', zh: '桃桃' }, plum: { en: 'Plum', zh: '李子' }, button: { en: 'Button', zh: '纽扣' }, marble: { en: 'Marble', zh: '弹珠' },
  muffin: { en: 'Muffin', zh: '松饼' }, nori: { en: 'Nori', zh: '海苔' }, tofu: { en: 'Tofu', zh: '豆腐' }, biscuit: { en: 'Biscuit', zh: '饼干' },
  berry: { en: 'Berry', zh: '莓莓' }, cocoa: { en: 'Cocoa', zh: '可可' }, taro: { en: 'Taro', zh: '芋头' }, cloud: { en: 'Cloud', zh: '云朵' },
  pinecone: { en: 'Pinecone', zh: '松果' },
};

export interface NamedAssistant {
  /** What tells this assistant apart in the account, the same on every device: its group and view, or its session. */
  readonly key: string;
  /** The name the owner gave it, or that its first edit stored. */
  readonly name?: string;
}

const fold = (name: string) => name.trim().toLowerCase();

/** A key's place in the list of names: FNV-1a over its UTF-16 units, the same in every runtime. */
export function assistantNameIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % ASSISTANT_NAME_IDS.length;
}

/**
 * The names the assistants of one account are called by, by key; `word(id)` is a default name in the reader's language (the protocol's
 * words, or a client catalogue that has the same ones).
 */
export function chooseAssistantNames(assistants: readonly NamedAssistant[], word: (id: AssistantNameId) => string): Map<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const assistant of assistants) {
    const stored = assistant.name?.trim();
    if (stored) { names.set(assistant.key, stored); taken.add(fold(stored)); }
  }
  // A name is free when no assistant is called by it in either language.
  const both = (id: AssistantNameId) => [ASSISTANT_NAME_WORDS[id].en, ASSISTANT_NAME_WORDS[id].zh].map(fold);
  const free = (id: AssistantNameId) => both(id).every(name => !taken.has(name));
  const unnamed = [...new Set(assistants.filter(assistant => !names.has(assistant.key)).map(assistant => assistant.key))].sort();
  for (const key of unnamed) {
    const start = assistantNameIndex(key);
    let chosen: string | undefined;
    for (let step = 0; step < ASSISTANT_NAME_IDS.length && !chosen; step += 1) {
      const id = ASSISTANT_NAME_IDS[(start + step) % ASSISTANT_NAME_IDS.length]!;
      if (free(id)) { chosen = word(id); for (const name of both(id)) taken.add(name); }
    }
    if (!chosen) {
      const base = word(ASSISTANT_NAME_IDS[start]!);
      let number = 2;
      while (taken.has(fold(`${base} ${number}`))) number += 1;
      chosen = `${base} ${number}`;
    }
    names.set(key, chosen); taken.add(fold(chosen));
  }
  return names;
}

/** The names, by key, in one of the languages the protocol has words for. */
export const assistantNamesIn = (assistants: readonly NamedAssistant[], locale: AssistantNameLocale): Map<string, string> =>
  chooseAssistantNames(assistants, id => ASSISTANT_NAME_WORDS[id][locale]);

/** What names a view's assistant in the account: its group and view, the same on every device. */
export const viewAssistantKey = (groupId: string, viewId: string): string => `${groupId}/${viewId}`;

/** The assistants of an account: every bot view of every group, with the name its details store. */
export function accountAssistants(groups: readonly WindowGroup[]): NamedAssistant[] {
  return groups.flatMap(group => botViews(group).map(view => {
    const name = group.bots?.members[view.id]?.name;
    return { key: viewAssistantKey(group.window.id, view.id), ...(name ? { name } : {}) };
  }));
}
