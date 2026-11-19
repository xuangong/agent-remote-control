// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { sessionKey } from '../session-tree.js';
import { canHandoffPrimary, commandRefusal, conversationActionsAvailable, handoffCompletionMatches, handoffInputBlocker, pendingInputBlocker, primaryHandoffGated, successionAccessible } from './succession-gates.js';

describe('whether a command may go out', () => {
  const ok = { accessReady: true, successionActive: false, nativeConfirmed: true, clientIsSubmitted: true };
  it('has no refusal for a ready conversation', () => expect(commandRefusal(ok)).toBeUndefined());
  it('refuses while access is restoring, before anything else', () => {
    expect(commandRefusal({ ...ok, accessReady: false, successionActive: true, nativeConfirmed: false, clientIsSubmitted: false })).toBe('access-restoring');
  });
  it('refuses an unconfirmed native session of a succession view, before a changed conversation', () => {
    expect(commandRefusal({ ...ok, successionActive: true, nativeConfirmed: false, clientIsSubmitted: false })).toBe('native-unconfirmed');
  });
  it('ignores the native confirmation without a succession view', () => expect(commandRefusal({ ...ok, nativeConfirmed: false })).toBeUndefined());
  it('refuses once the conversation changed under the action', () => expect(commandRefusal({ ...ok, clientIsSubmitted: false })).toBe('conversation-changed'));
});

describe('which conversation actions are offered', () => {
  it('all of them while ready and reachable, only the message handlers otherwise', () => {
    expect(conversationActionsAvailable({ accessReady: true, hostOffline: false, status: 'ready' })).toBe(true);
    expect(conversationActionsAvailable({ accessReady: false, hostOffline: false, status: 'ready' })).toBe(false);
    expect(conversationActionsAvailable({ accessReady: true, hostOffline: true, status: 'ready' })).toBe(false);
    expect(conversationActionsAvailable({ accessReady: true, hostOffline: false, status: 'connecting' })).toBe(false);
  });
});

describe('offering a Handoff of the main conversation', () => {
  const ok = { dialogOpen: false, hasDirectory: true, userScoped: true, accessReady: true, hostOffline: false, status: 'ready', primaryBound: true, transitioning: false,
    detachedSide: false, fork: false, readOnly: false, hasPrimary: true, isSubagent: false, history: false, hostAllowsHandoff: true };
  it('is offered when every fact holds', () => expect(canHandoffPrimary(ok)).toBe(true));
  it.each([
    ['a Handoff dialog is open', { dialogOpen: true }], ['there is no directory', { hasDirectory: false }], ['the user is not signed in', { userScoped: false }],
    ['access is restoring', { accessReady: false }], ['the Host is offline', { hostOffline: true }], ['the session is not ready', { status: 'connecting' }],
    ['the main session is not bound', { primaryBound: false }], ['a session is opening', { transitioning: true }], ['a Side is detached', { detachedSide: true }],
    ['it is a fork', { fork: true }], ['it is read-only', { readOnly: true }], ['there is no main session', { hasPrimary: false }],
    ['it is a subagent', { isSubagent: true }], ['it is a history view', { history: true }], ['the Host is shared or offline for Handoff', { hostAllowsHandoff: false }],
  ])('is not offered when %s', (_name, change) => expect(canHandoffPrimary({ ...ok, ...change })).toBe(false));
});

describe('unsent messages block a Handoff', () => {
  const base = { dialogOpen: true, sourceIsGroupView: false, groupPending: 0, sourceIsPrimary: false, primaryPending: 0 };
  it('never without a dialog', () => expect(handoffInputBlocker({ ...base, dialogOpen: false, sourceIsPrimary: true, primaryPending: 2, groupPending: 2 })).toBeUndefined());
  it('counts the pending inputs of a group view', () => {
    expect(handoffInputBlocker({ ...base, sourceIsGroupView: true, groupPending: 1 })).toBe(pendingInputBlocker);
    expect(handoffInputBlocker({ ...base, sourceIsGroupView: true, groupPending: 0, primaryPending: 3, sourceIsPrimary: true })).toBeUndefined();
  });
  it('counts the main composer for the primary conversation', () => {
    expect(handoffInputBlocker({ ...base, sourceIsPrimary: true, primaryPending: 1 })).toBe(pendingInputBlocker);
    expect(handoffInputBlocker({ ...base, sourceIsPrimary: true, primaryPending: 0 })).toBeUndefined();
  });
  it('does not count the main composer for another conversation', () => expect(handoffInputBlocker({ ...base, primaryPending: 3 })).toBeUndefined());
  it('says what to do', () => expect(pendingInputBlocker).toBe('Send or remove pending messages before handing off this conversation.'));
});

describe('a started Handoff holds the main conversation', () => {
  const base = { gated: true, dialogInScope: true, hasPrimary: true, primaryIsSource: true, desiredIsResumed: false };
  it('while it is its source', () => expect(primaryHandoffGated(base)).toBe(true));
  it('while it is the operation being resumed, whichever conversation is shown', () => expect(primaryHandoffGated({ ...base, primaryIsSource: false, desiredIsResumed: true })).toBe(true));
  it.each([['not gated', { gated: false }], ['out of scope', { dialogInScope: false }], ['without a main conversation', { hasPrimary: false }],
    ['for an unrelated conversation', { primaryIsSource: false }]])('does not hold it when %s', (_name, change) => expect(primaryHandoffGated({ ...base, ...change })).toBe(false));
});

describe('continuing a Handoff', () => {
  const ok = { accessReady: true, dialogInScope: true, userScoped: true, hostAllowsHandoff: true };
  it('needs access, the page scope it started in, a signed-in user and an authorized Host', () => {
    expect(successionAccessible(ok)).toBe(true);
    for (const change of [{ accessReady: false }, { dialogInScope: false }, { userScoped: false }, { hostAllowsHandoff: false }]) expect(successionAccessible({ ...ok, ...change })).toBe(false);
  });
});

describe('a Handoff that settled', () => {
  const ref = (id: string) => ({ providerId: 'codex', nativeSessionId: id, controllerId: 'c1' });
  const source = { hostId: 'h1', providerId: 'codex', nativeSessionId: 'old' };
  const keyOf = (id: string) => sessionKey({ hostId: 'h1', providerId: 'codex', nativeSessionId: id });
  const receipt = { phase: 'committed', operationId: 'op', roleId: 'role', expectedRevision: 1, committedRevision: 2, from: ref('old'), to: ref('new') };
  const checkpoint = { roleId: 'role', appliedRevision: 2, desired: { operationId: 'op', expectedRevision: 1, committedRevision: 2, from: ref('old'), to: ref('new') } };
  const moved = { source, mappedKey: keyOf('new'), receipt, role: { id: 'role', revision: 2, current: ref('new') }, checkpoint,
    pending: { operationId: 'op', expectedRevision: 1 }, verified: { operationId: 'op', target: ref('new') }, requireVerified: true };
  const matches = (change: Partial<typeof moved>) => handoffCompletionMatches({ ...moved, ...change });
  it('matches while the view still shows the source, or no view is mapped, with nothing else checked', () => {
    expect(matches({ mappedKey: keyOf('old'), receipt: { ...receipt, phase: 'rejected' }, checkpoint: undefined })).toBe(true);
    expect(matches({ mappedKey: undefined, checkpoint: undefined })).toBe(true);
  });
  it('matches a view that already shows the committed target and whose records agree', () => expect(matches({})).toBe(true));
  it('does not need the verified context before the checkpoint is applied', () => {
    expect(matches({ requireVerified: false, verified: undefined, checkpoint: { ...checkpoint, appliedRevision: 1 } })).toBe(true);
  });
  const broken: [string, Partial<typeof moved>][] = [
    ['the receipt is not committed', { receipt: { ...receipt, phase: 'preparing' } }],
    ['the receipt has no target', { receipt: { ...receipt, to: undefined as never } }],
    ['the role has no checkpoint', { checkpoint: undefined }],
    ['no intent is pending', { pending: undefined }],
    ['the pending operation differs', { pending: { operationId: 'other', expectedRevision: 1 } }],
    ['the pending revision differs', { pending: { operationId: 'op', expectedRevision: 9 } }],
    ['the checkpoint operation differs', { checkpoint: { ...checkpoint, desired: { ...checkpoint.desired, operationId: 'other' } } }],
    ['the checkpoint role differs', { checkpoint: { ...checkpoint, roleId: 'other' } }],
    ['the settled role differs', { role: { id: 'other', revision: 2, current: ref('new') } }],
    ['the checkpoint expected revision differs', { checkpoint: { ...checkpoint, desired: { ...checkpoint.desired, expectedRevision: 9 } } }],
    ['the checkpoint committed revision differs', { checkpoint: { ...checkpoint, desired: { ...checkpoint.desired, committedRevision: 9 } } }],
    ['the role revision differs', { role: { id: 'role', revision: 9, current: ref('new') } }],
    ['the checkpoint source differs', { checkpoint: { ...checkpoint, desired: { ...checkpoint.desired, from: ref('else') } } }],
    ['the receipt source is not the source view', { receipt: { ...receipt, from: ref('else') } }],
    ['the checkpoint target differs', { checkpoint: { ...checkpoint, desired: { ...checkpoint.desired, to: ref('else') } } }],
    ['the role is not at the target', { role: { id: 'role', revision: 2, current: ref('else') } }],
    ['the view shows another session than the target', { mappedKey: keyOf('else') }],
  ];
  it.each(broken)('does not match when %s', (_name, change) => expect(matches(change)).toBe(false));
  const unverified: [string, Partial<typeof moved>][] = [
    ['there is no verified context', { verified: undefined }],
    ['the verified operation differs', { verified: { operationId: 'other', target: ref('new') } }],
    ['the checkpoint is not applied at the committed revision', { checkpoint: { ...checkpoint, appliedRevision: 1 } }],
    ['the verified target differs', { verified: { operationId: 'op', target: ref('else') } }],
  ];
  it.each(unverified)('does not match once applied is required and %s', (_name, change) => expect(matches(change)).toBe(false));
});
