import { describe, expect, it } from 'vitest';
import { accessLocale, accessPlan, accessView, accessWord, accessWordsOf, type AccessPageState } from './access-page.js';
import { ACCESS_LOCALE_VECTORS, ACCESS_PLAN_VECTORS } from './access-page.vectors.js';

describe('the access pages', () => {
  it.each(ACCESS_PLAN_VECTORS)('$state with $facts', ({ state, facts, plan }) => {
    expect(accessPlan(state, facts)).toEqual(plan);
  });

  it('waits quietly in every busy state: one sentence and nothing else', () => {
    for (const state of ['checking', 'verifying', 'opening'] as AccessPageState[]) {
      for (const sessionLink of [false, true]) expect(accessPlan(state, { sessionLink }).kind, state).toBe('wait');
    }
    for (const state of ['signin', 'expired', 'unavailable'] as AccessPageState[]) expect(accessPlan(state).kind, state).toBe('card');
  });

  it('speaks both languages with the same words and placeholders', () => {
    const en = accessWordsOf('en'), zh = accessWordsOf('zh');
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(zh[key].trim(), key).not.toBe('');
      expect(holes(zh[key]), key).toEqual(holes(en[key]));
    }
  });

  it('says what the reader is doing while it waits, never how access works', () => {
    for (const locale of ['en', 'zh'] as const) for (const { state, facts } of ACCESS_PLAN_VECTORS) {
      const view = accessView(state, locale, facts);
      if (view.kind === 'wait') expect(view.sentence, `${locale} ${state}`).not.toMatch(/access|check|restor|verif|session|访问|验证|恢复/i);
    }
    expect(accessView('checking', 'zh')).toEqual({ kind: 'wait', sentence: '正在打开 Orchard…' });
    expect(accessView('verifying', 'en')).toEqual({ kind: 'wait', sentence: 'Signing you in…' });
  });

  it('fills a placeholder it is given', () => {
    expect(accessWord('en', 'cli.approve.code', { code: 'BCDFGHJK' })).toBe('Code BCDFGHJK: check that your terminal shows the same.');
    expect(accessWord('zh', 'cli.approve.description', { label: 'MacBook' })).toMatch(/^MacBook 想以你的身份使用 Orchard/);
  });

  it.each(ACCESS_LOCALE_VECTORS)('picks the locale of %j: %s', (languages, locale) => {
    expect(accessLocale(languages)).toBe(locale);
  });
});
