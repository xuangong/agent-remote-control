// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { CompositionSlot } from '../kernel/session-composition-model.js';
import { paneDraftOwners, storeFor } from './draft-ownership.js';

const slot = (): CompositionSlot => ({
  id: 'slot', origin: { target: { hostId: 'h1', native: { providerId: 'codex', nativeSessionId: 'n1' } } },
  owners: { text: { scope: 'https://relay', key: 'k-text' }, image: { scope: 'https://relay', key: 'k-image' }, display: { scope: 'https://relay', key: 'k-display' } },
} as unknown as CompositionSlot);

describe('pane draft owners', () => {
  it('has none for a pane without a slot', () => {
    expect(paneDraftOwners(undefined, false, 'https://relay')).toBeUndefined();
    expect(paneDraftOwners(undefined, true, 'https://relay')).toBeUndefined();
  });

  it('uses the slot owners for an ordinary pane', () => {
    expect(paneDraftOwners(slot(), false, 'https://relay')).toEqual({ text: { scope: 'https://relay', key: 'k-text' }, image: { scope: 'https://relay', key: 'k-image' } });
  });

  it('keeps a managed pane on the draft of its origin session under the device scope', () => {
    const owners = paneDraftOwners(slot(), true, 'https://device');
    expect(owners!.text).toEqual({ scope: 'https://device', key: expect.stringMatching(/^session:.*n1/) });
    expect(owners!.image.scope).toBe('https://device');
    expect(JSON.parse(owners!.image.key)).toEqual(['https://device', owners!.text.key.slice('session:'.length)]);
  });

  it('gives two managed panes of one origin the same draft', () => {
    const other = { ...slot(), id: 'other' } as CompositionSlot;
    expect(paneDraftOwners(other, true, 'u')).toEqual(paneDraftOwners(slot(), true, 'u'));
  });
});

describe('draft stores', () => {
  it('creates a store once per scope', () => {
    const stores = new Map<string, { scope: string }>(), created: string[] = [];
    const create = (scope: string) => { created.push(scope); return { scope }; };
    expect(storeFor(stores, 'a', create)).toBe(storeFor(stores, 'a', create));
    storeFor(stores, 'b', create);
    expect(created).toEqual(['a', 'b']);
  });
});
