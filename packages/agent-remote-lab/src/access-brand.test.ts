// @vitest-environment node
import { chooseLocale, LANGUAGE_STORAGE_KEY } from '@orchardworks/agent-client';
import { SESSION_CONNECTION_PATTERN, SESSION_CONNECTION_WORDS } from '@orchardworks/agent-client/testing';
import { markSvg, orchardColors, type ThemedColor } from '@orchardworks/agent-client-web/theme';
import { accessLanguageKey, accessLocale, accessMark, accessPageStyle, accessView, accessWordsOf, type AccessLocale } from '@orchardworks/agent-relay-core/access-page';
import { expect, it } from 'vitest';

/** The drawing without the attributes that depend on where it sits. */
const drawing = (svg: string) => svg.trim().replace(' aria-hidden="true" focusable="false"', '').replaceAll('arc-tile', 'tile');

it('draws the access pages\' mark from the one drawing of the Orchard mark', () => {
  expect(drawing(accessMark)).toBe(drawing(markSvg()));
});

/** The `light-dark(a, b)` pairs of a style, each with its colours split at the top-level comma. */
function colourPairs(style: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (let at = style.indexOf('light-dark('); at >= 0; at = style.indexOf('light-dark(', at + 1)) {
    let depth = 0, comma = -1, end = -1;
    for (let index = at + 'light-dark('.length - 1; index < style.length; index++) {
      if (style[index] === '(') depth++;
      else if (style[index] === ')' && --depth === 0) { end = index; break; }
      else if (style[index] === ',' && depth === 1) comma = index;
    }
    const inner = at + 'light-dark('.length;
    pairs.push([style.slice(inner, comma).trim(), style.slice(comma + 1, end).trim()]);
  }
  return pairs;
}

it('writes every colour of the access style as the light and dark value of an Orchard token', () => {
  const tokens = Object.values(orchardColors) as ThemedColor[];
  const pairs = colourPairs(accessPageStyle);
  expect(pairs.length).toBeGreaterThanOrEqual(10);
  for (const [light, dark] of pairs) expect(tokens.some(token => token.light === light && token.dark === dark), `${light} / ${dark}`).toBe(true);
  const outside = accessPageStyle.replace(/light-dark\((?:[^()]|\([^()]*\))*\)/g, '');
  expect(outside).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(|var\(--(?!arc-)/i);
  expect(accessPageStyle).toContain('color-scheme:light dark');
});

it('keeps the device\'s language key of the client', () => {
  expect(accessLanguageKey).toBe(LANGUAGE_STORAGE_KEY);
});

it('picks the language the client picks for the same list of languages', () => {
  const rows: string[][] = [['zh-CN', 'en'], ['en-US', 'zh-CN'], ['fr-FR', 'zh-TW'], ['de-DE'], ['ZH_hk'], ['zh-Hans-CN', 'en'], ['en-GB'], []];
  for (const languages of rows) {
    expect(accessLocale(languages), JSON.stringify(languages)).toBe(chooseLocale(languages));
  }
});

it('never words a wait as the connection state of a session', () => {
  for (const locale of ['en', 'zh'] as AccessLocale[]) {
    for (const [state, sessionLink] of [['checking', false], ['checking', true], ['verifying', false], ['opening', false], ['opening', true]] as const) {
      const view = accessView(state, locale, { sessionLink });
      expect(view.kind).toBe('wait');
      const sentence = view.kind === 'wait' ? view.sentence : '';
      expect(sentence).not.toMatch(SESSION_CONNECTION_PATTERN);
      for (const word of SESSION_CONNECTION_WORDS) expect(sentence.toLowerCase()).not.toContain(word.toLowerCase());
    }
    for (const key of ['wait.checking', 'wait.checkingSession', 'wait.verifying', 'wait.opening', 'wait.openingSession'] as const) {
      expect(accessWordsOf(locale)[key]).not.toMatch(SESSION_CONNECTION_PATTERN);
    }
  }
});
