import { describe, expect, it, vi } from 'vitest';
import { buildSessionViewContext, elementsOf, firstElement } from '../../test/session-view-context.js';
import { replicaState } from '../../test/fixtures.js';
import { quoteContribution, quoteMessagesAction, type QuoteContributionInputs } from './quote-contribution.js';
import { QuoteAttachments, QuoteMessagesButton, QuoteNotice, QuoteSelectionBar } from './SessionQuotes.js';

const inputs = (overrides: Partial<QuoteContributionInputs> = {}): QuoteContributionInputs => ({
  baseUrl: 'http://relay', quoteSelection: undefined, quoteNotice: undefined, dispatchQuote: vi.fn(), quoteTargets: vi.fn(() => []), quoteSelected: vi.fn(async () => {}),
  quotedActions: vi.fn((base, viewId) => ({ ...base, quoted: viewId })), quoteEntrySelection: vi.fn((viewId, epoch) => ({ label: `${viewId}@${epoch}`, selected: undefined, select: vi.fn() })), ...overrides,
});
const quoting = (facts = {}) => buildSessionViewContext({ quoteView: 'view-s1', ...facts });
const selection = { viewId: 'view-s1', epoch: 'epoch-1', keys: new Set(['a', 'b']) };

describe('quoting in a session view', () => {
  it('says nothing in a view that takes no part in quoting', () => {
    expect(quoteContribution(inputs())(buildSessionViewContext())).toEqual({ composerStatus: null, composerContext: null });
  });

  it('selects entries of the current timeline epoch and takes quotes that come back', () => {
    const result = quoteContribution(inputs())(quoting());
    expect(result.props?.entrySelection).toMatchObject({ label: 'view-s1@epoch-1' });
    expect(result.props?.receiveQuotes).toBeTypeOf('function');
    expect(quoteContribution(inputs())(quoting({ context: { state: undefined } })).props).not.toHaveProperty('entrySelection');
  });

  it('wraps the actions as the quote view', () => {
    expect(quoteContribution(inputs())(quoting()).wrapActions!({})).toEqual({ quoted: 'view-s1' });
  });

  it('keeps the quote attachments of the view in the composer', () => {
    const attachments = firstElement(quoteContribution(inputs())(quoting()).composerContext);
    expect(attachments.type).toBe(QuoteAttachments);
    expect(attachments.props).toMatchObject({ scope: 'http://relay', viewId: 'view-s1' });
  });

  it('shows the selection bar for the view that owns the selection', () => {
    const quoteSelected = vi.fn(async () => {}), dispatchQuote = vi.fn();
    const view = quoting();
    const bar = firstElement(quoteContribution(inputs({ quoteSelection: selection, quoteSelected, dispatchQuote }))(view).composerStatus);
    expect(bar.type).toBe(QuoteSelectionBar);
    expect(bar.props).toMatchObject({ count: 2, busy: false });
    bar.props.onCancel(); bar.props.onQuote({ windowId: 'w', viewId: 'v' });
    expect(dispatchQuote).toHaveBeenCalledWith({ type: 'cancel' });
    expect(quoteSelected).toHaveBeenCalledWith('view-s1', view.source, replicaState, { windowId: 'w', viewId: 'v' });
    expect(elementsOf(quoteContribution(inputs({ quoteSelection: { ...selection, viewId: 'view-other' } }))(view).composerStatus)).toEqual([]);
  });

  it('shows the notice of a quote and dismisses it before opening the quoted session', async () => {
    const open = vi.fn(async () => {}), dispatchQuote = vi.fn();
    const notice = firstElement(quoteContribution(inputs({ quoteNotice: { viewId: 'view-s1', message: 'Quoted', open }, dispatchQuote }))(quoting()).composerStatus);
    expect(notice.type).toBe(QuoteNotice);
    notice.props.onOpen();
    expect(dispatchQuote).toHaveBeenCalledWith({ type: 'notice.dismiss' });
    expect(open).toHaveBeenCalled();
    expect(elementsOf(quoteContribution(inputs({ quoteNotice: { viewId: 'view-other', message: 'Quoted' } }))(quoting()).composerStatus)).toEqual([]);
  });

  it('offers the heading action that starts a selection only while none is under way in the view', () => {
    const select = vi.fn(), quoteEntrySelection = vi.fn(() => ({ label: '', selected: undefined, select }));
    const button = quoteMessagesAction({ quoteSelection: undefined, quoteEntrySelection })(quoting())!;
    expect(button.type).toBe(QuoteMessagesButton);
    button.props.onClick();
    expect(select).toHaveBeenCalledWith([], true);
    expect(quoteMessagesAction({ quoteSelection: selection, quoteEntrySelection })(quoting())).toBeNull();
    expect(quoteMessagesAction({ quoteSelection: undefined, quoteEntrySelection })(buildSessionViewContext())).toBeNull();
  });
});
