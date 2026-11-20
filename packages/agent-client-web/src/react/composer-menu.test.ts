import { describe, expect, it } from 'vitest';
import { composerMenu, type ComposerMenuFacts } from './composer-menu.js';
import { COMPOSER_MENU_VECTORS, READY } from './composer-menu.vectors.js';

describe('the composer menu', () => {
  it.each(COMPOSER_MENU_VECTORS)('$name', ({ facts, items, notes = {} }) => {
    const menu = composerMenu({ ...READY, ...facts } as ComposerMenuFacts);
    expect(menu.map(item => item.enabled ? item.id : `-${item.id}`)).toEqual(items);
    expect(Object.fromEntries(menu.filter(item => item.note).map(item => [item.id, item.note]))).toEqual(notes);
  });
});
