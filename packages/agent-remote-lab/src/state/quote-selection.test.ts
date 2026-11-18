// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { noQuote, reduceQuote, selectedKeys, type QuoteEvent, type QuoteNotice, type QuoteState } from './quote-selection.js';

const run = (...events: QuoteEvent[]): QuoteState => events.reduce(reduceQuote, noQuote);
const select = (viewId: string, keys: string[], value = true, epoch: string | null = 'e1'): QuoteEvent => ({ type: 'select', viewId, epoch, keys, value });
const notice: QuoteNotice = { viewId: 'v1', message: 'Quoted' };

describe('selecting messages to quote', () => {
  it('adds and removes keys in one view and epoch', () => {
    const state = run(select('v1', ['a', 'b']), select('v1', ['c']), select('v1', ['a'], false));
    expect([...state.selection!.keys]).toEqual(['b', 'c']);
  });

  it('starts over in another view and in another epoch', () => {
    expect([...run(select('v1', ['a']), select('v2', ['x'])).selection!.keys]).toEqual(['x']);
    expect([...run(select('v1', ['a']), select('v1', ['x'], true, 'e2')).selection!.keys]).toEqual(['x']);
  });

  it('forgets the progress and error of the selection it replaces', () => {
    const busy = run(select('v1', ['a']), { type: 'creating', viewId: 'v1', creationId: 'c1' }, { type: 'failed', viewId: 'v1', error: 'no' });
    expect(run(select('v1', ['a']), { type: 'creating', viewId: 'v1', creationId: 'c1' }, select('v2', ['x'])).selection).toEqual({ viewId: 'v2', epoch: 'e1', keys: new Set(['x']), error: undefined });
    expect(reduceQuote(busy, select('v1', ['b'])).selection).toMatchObject({ creationId: 'c1', busy: false, error: undefined });
  });

  it('dismisses the notice of an earlier quote', () => {
    expect(run({ type: 'quoted', viewId: 'v1', notice }, select('v1', ['a'])).notice).toBeUndefined();
  });

  it('cancels the selection and keeps the notice', () => {
    const state = reduceQuote(run(select('v1', ['a'])), { type: 'cancel' });
    expect(state.selection).toBeUndefined();
  });
});

describe('quoting', () => {
  it('marks a selection busy while its destination is created, keeping the creation id', () => {
    const state = run(select('v1', ['a']), { type: 'creating', viewId: 'v1', creationId: 'c1' });
    expect(state.selection).toMatchObject({ busy: true, creationId: 'c1', error: undefined });
  });

  it('ignores progress for a view that does not own the selection', () => {
    const base = run(select('v1', ['a']));
    expect(reduceQuote(base, { type: 'creating', viewId: 'v2', creationId: 'c' })).toBe(base);
    expect(reduceQuote(base, { type: 'failed', viewId: 'v2', error: 'x' })).toBe(base);
    expect(reduceQuote(base, { type: 'quoted', viewId: 'v2' }).selection).toBe(base.selection);
  });

  it('clears the selection on success and shows the notice when given', () => {
    const base = run(select('v1', ['a']), { type: 'creating', viewId: 'v1', creationId: 'c1' });
    expect(reduceQuote(base, { type: 'quoted', viewId: 'v1' }).selection).toBeUndefined();
    expect(reduceQuote(base, { type: 'quoted', viewId: 'v1', notice }).notice).toBe(notice);
  });

  it('keeps the selection with an error when quoting fails, ready to retry', () => {
    const base = run(select('v1', ['a']), { type: 'creating', viewId: 'v1', creationId: 'c1' });
    expect(reduceQuote(base, { type: 'failed', viewId: 'v1', error: 'down' }).selection).toMatchObject({ busy: false, error: 'down', creationId: 'c1', keys: new Set(['a']) });
  });

  it('keeps an earlier notice through a quote that gives none, and dismisses it on request', () => {
    const withNotice = run({ type: 'quoted', viewId: 'v1', notice });
    expect(reduceQuote(withNotice, { type: 'quoted', viewId: 'v1' }).notice).toBe(notice);
    expect(reduceQuote(withNotice, { type: 'notice.dismiss' }).notice).toBeUndefined();
  });
});

describe('selected keys of a view', () => {
  it('is only the owning view in the same epoch', () => {
    const state = run(select('v1', ['a']));
    expect(selectedKeys(state, 'v1', 'e1')).toEqual(new Set(['a']));
    expect(selectedKeys(state, 'v2', 'e1')).toBeUndefined();
    expect(selectedKeys(state, 'v1', 'e2')).toBeUndefined();
    expect(selectedKeys(noQuote, 'v1', 'e1')).toBeUndefined();
  });
});
