// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { quoteCreationId, quoteLanding, quoteSessionOptions, quoteStart } from './quote-flow.js';
import type { QuoteSelection } from './quote-selection.js';

const selection = (overrides: Partial<QuoteSelection> = {}): QuoteSelection => ({ viewId: 'v1', epoch: 'e1', keys: new Set(['k']), ...overrides });

describe('starting a quote', () => {
  it('is ready for the view that owns the selection in its epoch', () => expect(quoteStart(selection(), 'v1', 'e1')).toBe('ready'));
  it('does nothing without a selection, for another view, or while the destination is being created', () => {
    expect(quoteStart(undefined, 'v1', 'e1')).toBe('ignore');
    expect(quoteStart(selection(), 'v2', 'e1')).toBe('ignore');
    expect(quoteStart(selection({ busy: true }), 'v1', 'e1')).toBe('ignore');
  });
  it('refuses a selection of an earlier epoch, since the messages may be gone', () => {
    expect(quoteStart(selection(), 'v1', 'e2')).toBe('reloaded');
    expect(quoteStart(selection({ epoch: null }), 'v1', null)).toBe('ready');
    expect(quoteStart(selection({ epoch: null }), 'v1', 'e2')).toBe('reloaded');
  });
});

describe('creating the destination session of a quote', () => {
  it('reuses the id of the attempt that failed, and makes one otherwise', () => {
    expect(quoteCreationId({ creationId: 'old' }, () => 'new')).toBe('old');
    expect(quoteCreationId({}, () => 'new')).toBe('new');
  });
  it('stands where the source stands', () => {
    expect(quoteSessionOptions({ cwd: '/w', model: 'm' }, 'codex')).toEqual({ cwd: '/w', model: 'm' });
    expect(quoteSessionOptions({ cwd: null, model: null }, 'codex')).toEqual({});
    expect(quoteSessionOptions({ cwd: '/w', model: 'm' }, 'dsh')).toEqual({ cwd: '/w' });
  });
});

describe('where a quote lands', () => {
  const windows = [
    { id: 'open', title: 'Open', current: true, views: [{ viewId: 'a', title: 'A' }] },
    { id: 'other', title: 'Other', current: false, views: [{ viewId: 'b', title: 'B' }] },
  ];
  it('reveals a view of the open Window', () => expect(quoteLanding(windows, { windowId: 'open' }, 'a')).toEqual({ kind: 'reveal' }));
  it('reveals when the Window is not in the catalog', () => expect(quoteLanding(windows, { windowId: 'gone' }, 'a')).toEqual({ kind: 'reveal' }));
  it('leaves a notice naming the session and Window for another Window', () => {
    expect(quoteLanding(windows, { windowId: 'other' }, 'b')).toEqual({ kind: 'notice', windowId: 'other', message: 'Quoted into “B” in workbench “Other”.' });
  });
  it('names a generic session when the destination is not listed (a new session)', () => {
    expect(quoteLanding(windows, { windowId: 'other' }, 'new')).toMatchObject({ kind: 'notice', message: 'Quoted into “the session” in workbench “Other”.' });
  });
});
