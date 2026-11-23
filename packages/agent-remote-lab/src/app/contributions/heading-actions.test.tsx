import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Translate } from '@orchardworks/agent-client';
import { SessionHeadingActions } from '../../conversation/SessionHeadingActions.js';
import { SessionTitle } from '../../conversation/SessionTitle.js';
import { ChatSessionManager } from '../../features/sessions/ChatSessionManager.js';
import { StarButton } from '../../features/sessions/SessionFavorites.js';
import { QuoteMessagesButton } from '../../features/session-links/SessionQuotes.js';
import { SessionLink } from '../../kernel/SessionLink.js';
import { IconButton } from '../../ui/IconButton.js';
import { buildView, buildWindow } from '../../test/window-builders.js';
import { buildHost, buildSessionViewContext, elementsOf, firstElement } from '../../test/session-view-context.js';
import { headingActionsContribution, type HeadingActionsContributionInputs } from './heading-actions.js';

const t = ((key: string) => key) as Translate;
const view = buildView('v1'), sharedWindow = buildWindow([view]);

function setup(overrides: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) {
  const spies = { closeView: vi.fn(), setRenamingSession: vi.fn(), back: vi.fn() };
  const inputs = {
    baseUrl: 'http://relay', compactLayout: false, conversationHistory: { canBack: true, canForward: false, back: spies.back, forward: vi.fn() }, directory: {}, favorites: {},
    openLocalView: vi.fn(), openSession: vi.fn(), sessionEntries: [], setRenamingSession: spies.setRenamingSession, sharedWindow, succession: { localViews: () => [] }, userScoped: true,
    quoteSelection: undefined, quoteEntrySelection: vi.fn(), t, foldsOnClose: () => false, closeView: spies.closeView, ...overrides,
  } as unknown as HeadingActionsContributionInputs;
  const props = headingActionsContribution(inputs)(buildSessionViewContext({ view, isPrimary: true, ...facts })).props!;
  const overflow = elementsOf(props.sessionManager).find(element => element.type === SessionHeadingActions);
  const actions = overflow ? elementsOf(overflow.props.children as never) : [];
  return { props, ...spies, byType: (type: unknown) => elementsOf(props.sessionManager).filter(element => element.type === type), actions };
}

describe('the heading of a session view', () => {
  it('has none in Bot mode', () => {
    expect(setup({}, { botPresentation: true }).props).toEqual({ sessionManager: undefined, conversationPath: undefined });
  });

  it('closes the primary view with a button that says whether it folds', () => {
    const { byType, closeView } = setup({ foldsOnClose: () => true });
    const close = byType(IconButton)[0]!;
    expect(close.props).toMatchObject({ title: 'sessions.presentation.fold', label: 'sessions.presentation.closeGroup' });
    close.props.onClick();
    expect(closeView).toHaveBeenCalledWith('v1');
    expect(setup().byType(IconButton)[0]!.props.title).toBe('sessions.presentation.closeView');
    expect(setup({}, { isPrimary: false }).byType(IconButton)).toEqual([]);
  });

  it('stars the session outside a compact layout', () => {
    expect(setup().byType(StarButton)).toHaveLength(1);
    expect(setup({ compactLayout: true }).byType(StarButton)).toHaveLength(0);
  });

  it('lists the sessions of the primary view when there is a directory', () => {
    expect(setup().actions.some(element => element.type === ChatSessionManager)).toBe(true);
    expect(setup({ directory: undefined }).actions.some(element => element.type === ChatSessionManager)).toBe(false);
    expect(setup({ compactLayout: true }).actions.some(element => element.type === ChatSessionManager)).toBe(false);
    expect(setup({ compactLayout: true, succession: { localViews: () => [{}] } }).actions.some(element => element.type === ChatSessionManager)).toBe(true);
  });

  it('moves through the conversation history of the selected primary view', () => {
    const nav = (result: ReturnType<typeof setup>) => result.actions.find(element => element.type === 'nav') as ReactElement<{ children: ReactElement<{ disabled: boolean; onClick(): void }>[] }> | undefined;
    const [back, forward] = nav(setup())!.props.children as [ReactElement<{ disabled: boolean; onClick(): void }>, ReactElement<{ disabled: boolean }>];
    expect([back.props.disabled, forward.props.disabled]).toEqual([false, true]);
    back.props.onClick();
    expect(nav(setup({ sharedWindow: { ...sharedWindow, selectedPrimaryViewId: 'other' } }))).toBeUndefined();
  });

  it('links to the session as it is when available, as a binding otherwise', () => {
    expect(setup().actions.find(element => element.type === SessionLink)!.props.session).toMatchObject({ viewId: 'view-s1' });
    expect(setup({}, { available: false }).actions.find(element => element.type === SessionLink)!.props.session).not.toHaveProperty('viewId');
  });

  it('opens the bot in Bot mode, and starts quoting while no selection is under way', () => {
    const openBot = vi.fn(), quoteEntrySelection = vi.fn(() => ({ select: vi.fn() }));
    const result = setup({ quoteEntrySelection }, { openBot, quoteView: 'view-s1' });
    expect(result.actions.find(element => element.props.className === 'lab-open-in-bot')!.props.onClick).toBe(openBot);
    expect(result.actions.some(element => element.type === QuoteMessagesButton)).toBe(true);
    expect(setup().actions.some(element => element.type === QuoteMessagesButton)).toBe(false);
  });

  it('shows the title of the session and renames it only on an online owned Host that can', () => {
    const renameable = buildHost({ providers: [{ providerId: 'codex', displayName: 'Codex', sessionRename: true }] });
    const title = (result: ReturnType<typeof setup>) => firstElement(result.props.conversationPath);
    expect(title(setup()).type).toBe(SessionTitle);
    expect(title(setup()).props).toMatchObject({ title: 's1', className: 'lab-primary-title', onRename: undefined });
    const named = setup({}, { host: renameable });
    title(named).props.onRename();
    expect(named.setRenamingSession).toHaveBeenCalledWith({ scope: 'http://relay', session: expect.objectContaining({ nativeSessionId: 's1' }) });
    expect(title(setup({ userScoped: false }, { host: renameable })).props.onRename).toBeUndefined();
    expect(title(setup({}, { host: { ...renameable, access: 'shared' } })).props.onRename).toBeUndefined();
  });
});
