import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cliWord, cliWordsOf } from './access-cli-words.js';
import { accessLocale, accessPlan, accessView, accessWord, accessWordsOf, type AccessPageState } from './access-page.js';
import { authenticationCallback } from './auth-callback.js';
import { authenticationFailure } from './auth-error.js';
import { cliApprovalPage } from './cli-access.js';
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

  it('speaks the command line page in both languages with the same words and placeholders', () => {
    const en = cliWordsOf('en'), zh = cliWordsOf('zh');
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) { expect(zh[key].trim(), key).not.toBe(''); expect(holes(zh[key]), key).toEqual(holes(en[key])); }
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
    expect(cliWord('en', 'approve.code', { code: 'BCDFGHJK' })).toBe('Code BCDFGHJK: check that your terminal shows the same.');
    expect(cliWord('zh', 'approve.description', { label: 'MacBook' })).toMatch(/^MacBook 想以你的身份使用 Orchard/);
  });

  it.each(ACCESS_LOCALE_VECTORS)('picks the locale of %j: %s', (languages, locale) => {
    expect(accessLocale(languages)).toBe(locale);
  });

  describe('the pages the Relay serves', () => {
    const origin = 'https://relay.example';
    const pages: [string, (language: string) => Response][] = [
      ['callback', language => authenticationCallback(origin, language)],
      ['denied', language => authenticationFailure(origin, 'denied', '/?host=a&session=b', language)],
      ['capacity', language => authenticationFailure(origin, 'capacity', undefined, language)],
      ['unavailable', language => authenticationFailure(origin, 'unavailable', undefined, language)],
      ['cli approve', language => cliApprovalPage(origin, { state: 'approve', userCode: 'BCDFGHJK', label: 'Mac <book>' }, language)],
      ['cli signin', language => cliApprovalPage(origin, { state: 'signin' }, language)],
      ['cli reauthenticate', language => cliApprovalPage(origin, { state: 'reauthenticate' }, language)],
      ['cli unavailable', language => cliApprovalPage(origin, { state: 'unavailable' }, language)],
    ];
    const hashOf = (value: string) => createHash('sha256').update(value).digest('base64');

    it.each(pages.flatMap(([name, render]) => (['en', 'zh-CN'] as const).map(language => [name, render, language] as const)))('%s in %s has the brand, its language and a card or a quiet wait', async (name, render, language) => {
      const response = render(language), html = await response.text();
      expect(html).toContain(`<html lang="${language === 'en' ? 'en' : 'zh-CN'}">`);
      expect(html).toContain('<svg');
      expect(html).toContain('arc-tile');
      expect(html).toContain(language === 'en' ? '<title>' + (name.startsWith('cli') ? 'Command line access · Orchard' : 'Sign in · Orchard') : '<title>' + (name.startsWith('cli') ? '命令行访问 · Orchard' : '登录 · Orchard'));
      expect(html).not.toContain('Agent Remote');
      expect(html).not.toMatch(/--obs-|--ui-|var\(--(?!arc-)/);
      expect(html).toContain('light-dark(');
      expect(html).toContain('>orchard<');
      expect(html).toContain('relay.example');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      if (name === 'callback') {
        expect(html).toContain('data-kind="wait"');
        expect(html).toContain(`id="access-status" role="status">${language === 'en' ? 'Signing you in…' : '正在登录…'}</p>`);
        expect(html).toMatch(/<h1 id="access-title" tabindex="-1"><\/h1>/);
      } else {
        expect(html).toContain('data-kind="card"');
        expect(html).not.toContain('class="arc-access-sentence"');
        expect(html).not.toMatch(/<h1[^>]*><\/h1>/);
      }
      const style = html.match(/<style>([\s\S]*?)<\/style>/)![1]!;
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      const policy = response.headers.get('content-security-policy')!;
      expect(policy).toContain(`style-src 'sha256-${hashOf(style)}'`);
      if (script) expect(policy).toContain(`script-src 'sha256-${hashOf(script)}'`);
      else expect(policy).not.toContain('script-src');
      // The tab shows the Orchard mark: the icons are linked, and the policy lets the page load them from its own origin.
      expect(html).toContain('<link rel="icon" href="/favicon.ico"');
      expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
      expect(policy).toContain("img-src 'self'");
    });

    it('escapes what a command line names itself and keeps the code readable', async () => {
      const html = await cliApprovalPage(origin, { state: 'approve', userCode: 'BCDFGHJK', label: 'Mac <book>' }).text();
      expect(html).toContain('Mac &lt;book&gt; asks to act as you in Orchard');
      expect(html).toContain('Code <strong>BCDFGHJK</strong>: check that your terminal shows the same.');
    });

    it('lets the callback prefer the device\'s language and keeps both languages for every state it shows', async () => {
      const html = await authenticationCallback(origin, 'en-US').text();
      expect(html).toContain("localStorage.getItem(\"agent-remote:language\")");
      for (const word of ['Signing you in…', '正在登录…', 'Let’s sign in again', '再登录一次吧', 'Can’t reach Orchard right now', '暂时连不上 Orchard', 'Signed in. Opening your conversation…']) expect(html).toContain(word);
    });
  });
});
