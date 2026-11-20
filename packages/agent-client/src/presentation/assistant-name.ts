/**
 * The name an assistant is called by, everywhere it shows: the sidebar, the top bar, the live line, a tile and the details
 * (I3c, the coordinator's naming rule). A session's title is never the name: it is often the first prompt ("Reply with the
 * words …"), and it stays the conversation's subtitle and a row of the sessions list.
 *
 * - An assistant with a stored name (the owner gave it, or a first edit stored the generated one) is called by it.
 * - Any other assistant is called by a name from `ASSISTANT_NAME_IDS`, in the reader's language. Its key picks the name, so
 *   every device calls it the same; no other assistant of the account has that name in either language. Assistants without
 *   a name take their names in the order of their keys; when every name is taken they are numbered ("Dango 2").
 */
import { translator, type MessageKey, type Translate } from './messages.js';

/** The default names, soft small things in the design's spirit; the catalogue has each in English and Chinese (`name.<id>`). */
export const ASSISTANT_NAME_IDS = [
  'dango', 'gummies', 'nest', 'pebbles', 'hatch', 'mochi', 'bean', 'puff', 'sprout', 'pudding', 'acorn', 'bun', 'peach',
  'plum', 'button', 'marble', 'muffin', 'nori', 'tofu', 'biscuit', 'berry', 'cocoa', 'taro', 'cloud', 'pinecone',
] as const;
export type AssistantNameId = typeof ASSISTANT_NAME_IDS[number];

export interface NamedAssistant {
  /** What tells this assistant apart in the account, the same on every device: its group and view, or its session. */
  readonly key: string;
  /** The name the owner gave it, or that its first edit stored. */
  readonly name?: string;
}

const english = translator('en'), chinese = translator('zh');
const nameKey = (id: AssistantNameId) => `name.${id}` as MessageKey;
const fold = (name: string) => name.trim().toLowerCase();

/** A key's place in the list of names: FNV-1a over its UTF-16 units, the same in every browser. */
export function assistantNameIndex(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) { hash ^= key.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % ASSISTANT_NAME_IDS.length;
}

/** The names the assistants of one account are called by, by key, in the language of `t`. */
export function assistantNames(assistants: readonly NamedAssistant[], t: Translate = english): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const assistant of assistants) {
    const stored = assistant.name?.trim();
    if (stored) { names.set(assistant.key, stored); taken.add(fold(stored)); }
  }
  // A name is free when no assistant is called by it in either language.
  const free = (id: AssistantNameId) => !taken.has(fold(english(nameKey(id)))) && !taken.has(fold(chinese(nameKey(id))));
  const unnamed = [...new Set(assistants.filter(assistant => !names.has(assistant.key)).map(assistant => assistant.key))].sort();
  for (const key of unnamed) {
    const start = assistantNameIndex(key);
    let chosen: string | undefined;
    for (let step = 0; step < ASSISTANT_NAME_IDS.length && !chosen; step += 1) {
      const id = ASSISTANT_NAME_IDS[(start + step) % ASSISTANT_NAME_IDS.length]!;
      if (free(id)) { chosen = t(nameKey(id)); taken.add(fold(english(nameKey(id)))); taken.add(fold(chinese(nameKey(id)))); }
    }
    if (!chosen) {
      const base = t(nameKey(ASSISTANT_NAME_IDS[start]!));
      let number = 2;
      while (taken.has(fold(`${base} ${number}`))) number += 1;
      chosen = `${base} ${number}`;
    }
    names.set(key, chosen); taken.add(fold(chosen));
  }
  return names;
}

/** The name of one assistant among the others of its account (itself alone by default). */
export function assistantName(assistant: NamedAssistant, account: readonly NamedAssistant[] = [assistant], t: Translate = english): string {
  const all = account.some(item => item.key === assistant.key) ? account : [...account, assistant];
  return assistantNames(all, t).get(assistant.key)!;
}
