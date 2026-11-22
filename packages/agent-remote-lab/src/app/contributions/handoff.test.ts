import { describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import { handoffCommand } from '../../handoff-command.js';
import { buildHost, buildSessionViewContext } from '../../test/session-view-context.js';
import { handoffContribution, type HandoffContributionInputs } from './handoff.js';

const t = ((key: string) => key) as Translate;
const inputs = (overrides: Record<string, unknown> = {}) => ({
  baseUrl: 'http://relay', botHandoff: false, directory: {}, setSuccessionDialog: vi.fn(), sourceStateFor: () => undefined, successionDialog: undefined,
  successionGated: false, successionProgress: 'progress', userScoped: true, t, ...overrides,
}) as unknown as HandoffContributionInputs;
const idle = { agent: { status: 'idle' } };
const present = (overrides = {}, facts = {}) => handoffContribution(inputs(overrides))(buildSessionViewContext({ context: { state: idle as never }, ...facts }));

describe('handoff in a session view', () => {
  it('offers /handoff when the owner may hand the session off', () => {
    expect(present().consoleCommands).toEqual([handoffCommand]);
  });

  it.each([
    ['the session is not available', {}, { available: false }],
    ['a handoff dialog is already open', { successionDialog: { source: { viewId: 'other' } } }, {}],
    ['the account is not signed in', { userScoped: false }, {}],
    ['the Host is shared', {}, { host: buildHost({ access: 'shared' }) }],
    ['the Host is offline', {}, { host: buildHost({ online: false }) }],
    ['the session is a Side', {}, { source: { parentNativeSessionId: 'root' } }],
    ['the session is historical', {}, { context: { operationBinding: { historical: true } } }],
    ['the session is read only', {}, { context: { sessionState: { readOnly: true } } }],
  ])('does not offer /handoff when %s', (_reason, overrides, facts) => {
    expect(present(overrides, facts).consoleCommands).toEqual([]);
  });

  it('offers /handoff to a bot only while it is idle', () => {
    expect(present({}, { botPresentation: true }).consoleCommands).toEqual([handoffCommand]);
    expect(present({}, { botPresentation: true, context: { state: { agent: { status: 'running' } } as never } }).consoleCommands).toEqual([]);
  });

  it('opens the handoff dialog for the view with the provider named in the command', async () => {
    const setSuccessionDialog = vi.fn(), view = buildSessionViewContext({ context: { state: idle as never } });
    const result = handoffContribution(inputs({ setSuccessionDialog }))(view);
    expect(await result.onConsoleCommand!(handoffCommand.id, 'claude')).toEqual({});
    expect(setSuccessionDialog).toHaveBeenCalledWith(expect.objectContaining({ scope: 'http://relay', source: view.source, visible: true, initialProvider: 'claude' }));
  });

  it('leaves other commands alone, refuses when handoff is not possible and makes a working bot wait', () => {
    expect(present().onConsoleCommand!('console:fork', '')).toBeUndefined();
    expect(() => present({}, { available: false }).onConsoleCommand!(handoffCommand.id, '')).toThrow('sessions.presentation.handoffNeeds');
    const working = { sourceStateFor: () => ({ agent: { status: 'running' } }) };
    expect(() => present(working, { botPresentation: true }).onConsoleCommand!(handoffCommand.id, '')).toThrow('sessions.presentation.waitIdle');
  });

  it('shows the progress while this view hands off, unless the bot hands off elsewhere', () => {
    const dialog = { source: { viewId: 'view-s1' } };
    expect(present({ successionDialog: dialog }).composerStatus).toBe('progress');
    expect(present({ successionDialog: { source: { viewId: 'view-other' } } }).composerStatus).toBeNull();
    expect(present({ successionDialog: dialog, botHandoff: true }).composerStatus).toBeNull();
  });

  it('blocks sending while the gate of this view is closed', () => {
    const gated = { successionGated: true, successionDialog: { scope: 'http://relay', source: { viewId: 'view-s1' } } };
    expect(present(gated).blocksMutation).toBe(true);
    expect(present({ ...gated, successionDialog: { scope: 'http://elsewhere', source: { viewId: 'view-s1' } } }).blocksMutation).toBe(false);
    expect(present({ ...gated, successionGated: false }).blocksMutation).toBe(false);
  });
});
