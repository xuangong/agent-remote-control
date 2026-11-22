import { describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import type { ForkStore } from '../../kernel/session-forks.js';
import { buildSessionViewContext, elementsOf, firstElement } from '../../test/session-view-context.js';
import { replicaState } from '../../test/fixtures.js';
import { forkContribution, type ForkContributionInputs } from './fork-contribution.js';
import { ForkEntries } from './ForkReference.js';

const t = ((key: string) => key) as Translate;
const ownActions = { deleteMessage: vi.fn() };
const conversationActions = { deleteMessage: vi.fn() };

function inputs(overrides: Partial<ForkContributionInputs> = {}): ForkContributionInputs {
  return {
    forkStore: {} as ForkStore, actions: ownActions, transport: {} as never, readWindowViews: () => [], forkInputStatus: undefined, directory: {},
    createFork: vi.fn(async () => ({})), openFork: vi.fn(async () => {}), openSideKeys: () => ['side-1'], unlinkSide: vi.fn(async () => {}), reconcile: vi.fn(async () => {}), t, ...overrides,
  };
}
const present = (overrides: Partial<ForkContributionInputs> = {}, facts = {}) => forkContribution(inputs(overrides))(buildSessionViewContext({ context: { actions: conversationActions }, ...facts }));

describe('forks and Sides in a session view', () => {
  it('uses the session own actions outside Bot mode and the conversation actions in it', () => {
    expect(present().commandSet).toBe(ownActions);
    expect(present({ actions: undefined }).commandSet).toBe(conversationActions);
    expect(present({}, { botPresentation: true }).commandSet).toBe(conversationActions);
  });

  it('shows the conversation state in Bot mode', () => {
    expect(present({}, { botPresentation: true }).props?.state).toBe(replicaState);
  });

  it('marks a first input pending only for the session it belongs to', () => {
    expect(present({ forkInputStatus: { agentId: 'agent-s1', pending: true } }).firstInputPending).toBe(true);
    expect(present({ forkInputStatus: { agentId: 'agent-other', pending: true } }).firstInputPending).toBe(false);
    expect(present({ forkInputStatus: { agentId: 'agent-s1', pending: false } }).firstInputPending).toBe(false);
  });

  it('offers ask, fork and side when the session is available and can send and read its history', () => {
    expect(present().consoleCommands?.map(command => command.id)).toEqual(['console:ask', 'console:fork', 'console:side']);
    expect(present({}, { available: false }).consoleCommands).toEqual([]);
    expect(present({ directory: undefined }).consoleCommands).toEqual([]);
  });

  it('offers only a Side in Bot mode, and nothing in Other sessions', () => {
    expect(present({}, { botPresentation: true, options: { bot: { groupId: 'g', viewId: 'v' } } }).consoleCommands?.map(command => command.id)).toEqual(['console:side']);
    expect(present({}, { botPresentation: true, options: { fallback: true } }).consoleCommands).toEqual([]);
  });

  it('creates the fork from the current state and refuses what a bot cannot do', () => {
    const createFork = vi.fn(async () => ({}));
    const view = buildSessionViewContext({ botPresentation: true, options: { bot: { groupId: 'g', viewId: 'v' } } });
    const bot = forkContribution(inputs({ createFork }))(view);
    expect(() => bot.onConsoleCommand!('console:fork', '')).toThrow('sessions.presentation.botUnavailable');
    bot.onConsoleCommand!('console:side', 'topic');
    expect(createFork).toHaveBeenCalledWith(replicaState, view.source, 'console:side', 'topic');
  });

  it('waits for synchronisation before forking', () => {
    expect(() => present({}, { available: false }).onConsoleCommand!('console:fork', '')).toThrow('sessions.sending.waitSync');
  });

  it('lists the linked Sides under the composer, with the Sides open now', () => {
    const entries = firstElement(present({}, { sourceForks: [{ id: 'fork-1' } as never] }).composerNotice);
    expect(entries.type).toBe(ForkEntries);
    expect(entries.props).toMatchObject({ forks: [{ id: 'fork-1' }], openSides: ['side-1'] });
    expect(present({}, { botPresentation: true }).composerNotice).toBeUndefined();
  });
});
