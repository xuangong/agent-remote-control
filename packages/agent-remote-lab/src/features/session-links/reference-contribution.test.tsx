import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import { buildHost, buildSessionViewContext, elementsOf, firstElement } from '../../test/session-view-context.js';
import { referenceContribution, type ReferenceContributionInputs } from './reference-contribution.js';
import { ForkReference } from './ForkReference.js';
import { SessionReferences } from './SessionReferences.js';

const loadSessionRefs = vi.hoisted(() => vi.fn(async () => {}));
const unsupported = vi.hoisted(() => ({ value: false }));
vi.mock('../../kernel/session-references.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../kernel/session-references.js')>(),
  loadSessionRefs, sessionRefsEntry: () => ({ unsupported: unsupported.value }),
}));

const t = ((key: string) => key) as Translate;
const referencing = buildHost({ providers: [{ providerId: 'codex', displayName: 'Codex', sessionReferences: true }] });
const inputs = (overrides: Partial<ReferenceContributionInputs> = {}): ReferenceContributionInputs => ({
  baseUrl: 'http://relay', userScoped: true, directory: {}, referencePicker: undefined, setReferencePicker: vi.fn(), referencedActions: vi.fn((base, session) => ({ ...base, referenced: session.nativeSessionId })),
  openExcerptSource: vi.fn(), removedReference: vi.fn(), restoredReference: vi.fn(), revealSession: vi.fn(), unlinkSide: vi.fn(async () => {}), reconcile: vi.fn(async () => {}), t, ...overrides,
});
const present = (overrides: Partial<ReferenceContributionInputs> = {}, facts = {}) => referenceContribution(inputs(overrides))(buildSessionViewContext({ host: referencing, ...facts }));

beforeEach(() => { unsupported.value = false; loadSessionRefs.mockClear(); });

describe('session references in a session view', () => {
  it('lists the references in the composer when the Host keeps them', () => {
    const list = firstElement(present().composerContext);
    expect(list.type).toBe(SessionReferences);
    expect(list.props).toMatchObject({ scope: 'http://relay', holder: { hostId: 'local', providerId: 'codex', nativeSessionId: 's1' }, providers: ['codex'], picking: false });
  });

  it('shows the picker for the view that opened it', () => {
    expect(firstElement(present({ referencePicker: 'view-s1' }).composerContext).props.picking).toBe(true);
    expect(firstElement(present({ referencePicker: 'view-other' }).composerContext).props.picking).toBe(false);
  });

  it('shows the fork reference alone when references do not apply', () => {
    for (const facts of [{ host: buildHost() }, { host: buildHost({ ...referencing, access: 'shared' }) }]) {
      const result = present({}, { ...facts, fork: { id: 'fork-1', mode: 'reference' } as never });
      expect(firstElement(result.composerContext).type).toBe(ForkReference);
    }
    expect(present({ userScoped: false }).composerContext).toBeNull();
    expect(present({ directory: undefined }).composerContext).toBeNull();
  });

  it('offers /ref outside Bot mode when the session is available', () => {
    expect(present().consoleCommands?.map(command => command.id)).toEqual(['console:ref']);
    expect(present({}, { available: false }).consoleCommands).toEqual([]);
    expect(present({}, { botPresentation: true }).consoleCommands).toEqual([]);
    expect(present({ userScoped: false }).consoleCommands).toEqual([]);
  });

  it('wraps the actions with the page notes only when the Controller does not tell the agent itself', () => {
    const base = { deleteMessage: vi.fn() };
    expect(present().wrapActions!(base)).toMatchObject({ referenced: 's1' });
    const telling = buildHost({ providers: [{ providerId: 'codex', displayName: 'Codex', sessionReferences: true, referenceNotes: true }] });
    expect(present({}, { host: telling }).wrapActions).toBeUndefined();
    expect(present({}, { host: buildHost() }).wrapActions).toBeUndefined();
  });

  it('answers /ref before the source is checked, by opening the picker', async () => {
    const setReferencePicker = vi.fn();
    expect(await present({ setReferencePicker }).beforeSourceCheck!('console:ref', '')).toEqual({});
    expect(loadSessionRefs).toHaveBeenCalledWith('http://relay', { hostId: 'local', providerId: 'codex', nativeSessionId: 's1' });
    expect(setReferencePicker).toHaveBeenCalledWith('view-s1');
  });

  it('leaves another command to the others, and asks for a Controller update when the Host cannot list references', async () => {
    expect(present().beforeSourceCheck!('console:fork', '')).toBeUndefined();
    unsupported.value = true;
    await expect(present().beforeSourceCheck!('console:ref', '')).rejects.toThrow('sessions.presentation.refsNeedUpdate');
  });
});
