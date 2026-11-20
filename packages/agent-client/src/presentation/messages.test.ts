import { describe, expect, it } from 'vitest';
import { chooseLocale, elapsedWords, LOCALES, messageCatalogue, messagePlaceholders, pluralCategory, translator, type MessageKey } from './messages.js';

describe('the message catalogue', () => {
  const english = messageCatalogue('en');

  it.each(LOCALES)('%s has every key the other locales have, and no other', locale => {
    const keys = (of: typeof locale) => Object.keys(messageCatalogue(of)).sort();
    for (const other of LOCALES) expect(keys(locale), `${locale} against ${other}`).toEqual(keys(other));
  });

  it.each(LOCALES)('%s fills every message: no empty form, and an `other` form for each plural', locale => {
    for (const [key, message] of Object.entries(messageCatalogue(locale))) {
      if (typeof message === 'string') expect(message.trim(), key).not.toBe('');
      else for (const form of Object.values(message)) expect(form?.trim(), key).not.toBe('');
    }
  });

  it('uses the same placeholders in every locale', () => {
    for (const key of Object.keys(english) as MessageKey[]) {
      for (const locale of LOCALES) expect(messagePlaceholders(messageCatalogue(locale)[key]), `${locale} ${key}`).toEqual(messagePlaceholders(english[key]));
    }
  });

  it('counts its plurals in each locale: English has one and other, Chinese only other', () => {
    expect([0, 1, 2, 21].map(count => pluralCategory('en', count))).toEqual(['other', 'one', 'other', 'other']);
    expect([0, 1, 2].map(count => pluralCategory('zh', count))).toEqual(['other', 'other', 'other']);
  });

  it('fills placeholders and picks the plural form of count', () => {
    const t = translator('en');
    expect(t('work.commands', { count: 1 })).toBe('ran a command');
    expect(t('work.commands', { count: 3 })).toBe('ran 3 commands');
    expect(t('status.editing', { name: 'Chief', file: 'notes.md' })).toBe('Chief is editing notes.md');
    expect(translator('zh')('work.readFiles', { count: 3 })).toBe('翻了 3 个文件');
    expect(translator('zh')('work.commands', { count: 1 })).toBe('跑了 1 条命令');
  });

  it('speaks in the design voice in Chinese', () => {
    const t = translator('zh');
    expect([t('approval.allow'), t('approval.notNow'), t('approval.showChanges')]).toEqual(['好的', '先别', '看看要改什么']);
    expect(t('conversation.sessionChange')).toBe('换到新的会话继续');
    expect(t('approval.question', { name: 'Chief' })).toBe('Chief 想问你一件小事');
    expect(t('status.tests', { name: 'Builder' })).toBe('Builder 在跑测试，稍等～');
    expect(t('status.detail')).toBe('认真工作中');
  });

  it('leaves a placeholder it was not given, rather than inventing a value', () => {
    expect(translator('en')('status.reading', { name: 'Chief' })).toBe('Chief is reading {file}');
  });

  it.each([
    [['zh-CN', 'en-US'], 'zh'], [['en-GB', 'zh-CN'], 'en'], [['fr-FR', 'zh-TW'], 'zh'], [['zh_Hans'], 'zh'],
    [['fr-FR', 'de-DE'], 'en'], [[], 'en'], [['ZH-hk'], 'zh'],
  ] as const)('chooses the first language it speaks from %j: %s', (languages, locale) => {
    expect(chooseLocale(languages)).toBe(locale);
  });

  it('says elapsed time in short words', () => {
    const en = translator('en'), zh = translator('zh');
    expect([0, 12, 65, 3725].map(seconds => elapsedWords(seconds, en))).toEqual(['0s', '12s', '1m 05s', '1h 02m 05s']);
    expect(elapsedWords(65, zh)).toBe('1 分 05 秒');
  });
});
