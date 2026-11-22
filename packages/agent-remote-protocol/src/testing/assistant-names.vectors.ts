import type { AssistantNameLocale, NamedAssistant } from '../assistant-names.js';

/**
 * Assistants of one account and the names they are called by, row by row, in `locale` (English by default). Read by the protocol's
 * `assistant-names.test.ts` with its own words and by `agent-client`'s `assistant-name.test.ts` with the client's catalogue, so a
 * device and the Relay call every assistant the same.
 */
export interface AssistantNameVector { readonly name: string; readonly assistants: readonly NamedAssistant[]; readonly names: readonly string[]; readonly locale?: AssistantNameLocale }

const unnamed = (key: string): NamedAssistant => ({ key });
const named = (key: string, name: string): NamedAssistant => ({ key, name });
// Keys and the names they pick: `a` Berry (20), `b` Nest (2), `aa`, `cd` and `da` Nest (2), Pebbles follows Nest, Cocoa follows Berry.
const ENGLISH_LIST = ['Dango', 'Gummies', 'Nest', 'Pebbles', 'Hatch', 'Mochi', 'Bean', 'Puff', 'Sprout', 'Pudding', 'Acorn', 'Bun', 'Peach',
  'Plum', 'Button', 'Marble', 'Muffin', 'Nori', 'Tofu', 'Biscuit', 'Berry', 'Cocoa', 'Taro', 'Cloud', 'Pinecone'];

export const ASSISTANT_NAME_VECTORS: readonly AssistantNameVector[] = [
  { name: 'a stored name is the name', assistants: [named('a', 'Chief')], names: ['Chief'] },
  { name: 'an assistant without a name is called by the name its key picks', assistants: [unnamed('a')], names: ['Berry'] },
  { name: 'the same assistant in Chinese', assistants: [unnamed('a')], names: ['莓莓'], locale: 'zh' },
  { name: 'keys that pick one name take it and the names after it in the order of their keys, whatever order they come in',
    assistants: [unnamed('da'), unnamed('aa'), unnamed('cd')], names: ['Hatch', 'Nest', 'Pebbles'] },
  { name: 'a name another assistant stores is not given again', assistants: [named('x', 'Nest'), unnamed('b')], names: ['Nest', 'Pebbles'] },
  { name: 'a stored name takes its name in the other language too', assistants: [named('x', '窝'), unnamed('b')], names: ['窝', 'Pebbles'] },
  { name: 'names are compared without case or surrounding spaces', assistants: [named('x', ' berry '), unnamed('a')], names: ['berry', 'Cocoa'] },
  { name: 'a blank stored name is no name', assistants: [named('a', '   ')], names: ['Berry'] },
  { name: 'stored names may repeat; generated ones never do', assistants: [named('x', 'Chief'), named('y', 'Chief'), unnamed('aa'), unnamed('cd')],
    names: ['Chief', 'Chief', 'Nest', 'Pebbles'] },
  { name: 'when every name is taken, the name its key picks is numbered', assistants: [...ENGLISH_LIST.map((name, index) => named(`n${index}`, name)), unnamed('a')],
    names: [...ENGLISH_LIST, 'Berry 2'] },
  { name: 'when every name is taken, assistants whose keys pick one name are numbered one after the other', assistants: [...ENGLISH_LIST.map((name, index) => named(`n${index}`, name)), unnamed('cd'), unnamed('aa')],
    names: [...ENGLISH_LIST, 'Nest 3', 'Nest 2'] },
  { name: 'when every name is taken, the numbered name is in the reader\'s language', assistants: [...ENGLISH_LIST.map((name, index) => named(`n${index}`, name)), unnamed('a')],
    names: [...ENGLISH_LIST, '莓莓 2'], locale: 'zh' },
];
