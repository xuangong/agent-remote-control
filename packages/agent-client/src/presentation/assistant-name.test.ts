import { describe, expect, it } from 'vitest';
import { ASSISTANT_NAME_WORDS } from '@orchardworks/agent-remote-protocol';
import { ASSISTANT_NAME_VECTORS } from '@orchardworks/agent-remote-protocol/testing';
import { ASSISTANT_NAME_IDS, assistantName, assistantNames } from './assistant-name.js';
import { translator } from './messages.js';

describe('assistantNames', () => {
  it.each(ASSISTANT_NAME_VECTORS)('$name', ({ assistants, names, locale }) => {
    const called = assistantNames(assistants, translator(locale ?? 'en'));
    expect(assistants.map(assistant => called.get(assistant.key))).toEqual(names);
  });

  it('gives every assistant of an account a different name, the same in each language and order', () => {
    const keys = Array.from({ length: 60 }, (_, index) => `group-${index % 7}/view-${index}`);
    for (const locale of ['en', 'zh'] as const) {
      const called = assistantNames(keys.map(key => ({ key })), translator(locale));
      expect(new Set(called.values()).size).toBe(keys.length);
      const reversed = assistantNames([...keys].reverse().map(key => ({ key })), translator(locale));
      for (const key of keys) expect(reversed.get(key)).toBe(called.get(key));
    }
  });

  it('has twenty-five names, each in English and Chinese', () => {
    expect(ASSISTANT_NAME_IDS).toHaveLength(25);
    for (const locale of ['en', 'zh'] as const) {
      const names = ASSISTANT_NAME_IDS.map(id => translator(locale)(`name.${id}`));
      expect(new Set(names).size).toBe(25);
      for (const name of names) expect(name).not.toMatch(/^name\./);
    }
    expect(['dango', 'gummies', 'nest', 'pebbles', 'hatch'].map(id => translator('zh')(`name.${id}` as `name.${typeof ASSISTANT_NAME_IDS[number]}`))).toEqual(['团团', '软糖', '窝', '石子', '孵']);
  });

  it('has the protocol\'s words for every name, so the Relay calls an assistant what every page calls it', () => {
    for (const locale of ['en', 'zh'] as const) {
      expect(Object.fromEntries(ASSISTANT_NAME_IDS.map(id => [id, translator(locale)(`name.${id}`)]))).toEqual(Object.fromEntries(ASSISTANT_NAME_IDS.map(id => [id, ASSISTANT_NAME_WORDS[id][locale]])));
    }
  });
});

describe('assistantName', () => {
  it('names one assistant among the others of its account, and alone by default', () => {
    const account = [{ key: 'aa' }, { key: 'cd' }];
    expect(assistantName(account[1]!, account)).toBe('Pebbles');
    expect(assistantName(account[1]!)).toBe('Nest');
    expect(assistantName({ key: 'da' }, account)).toBe('Hatch');
  });
});
