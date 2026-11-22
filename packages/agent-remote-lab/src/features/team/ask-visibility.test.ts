// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildView, buildWindow } from '../../test/window-builders.js';
import { askActivityOf, askRestoreAllowed, askSourcesOf, askUnavailableReason, type AskActivityFacts } from './ask-visibility.js';

describe('the sessions that have an Ask', () => {
  const slots = [{ id: 's1', session: 'one' }, { id: 's2', session: undefined }, { id: 's3', session: 'three' }];
  const sessionOf = (slot: { session?: string }) => slot.session;
  it('follows the owners in order and names each source', () => {
    const asks = [{ id: 'a3', sourceSlot: 's3' }, { id: 'a1', sourceSlot: 's1' }];
    expect(askSourcesOf(slots, asks, sessionOf)).toEqual([{ owner: 'a3', source: 'three' }, { owner: 'a1', source: 'one' }]);
  });
  it('leaves out an owner whose slot is missing or has no session', () => {
    expect(askSourcesOf(slots, [{ id: 'a2', sourceSlot: 's2' }, { id: 'ax', sourceSlot: 'missing' }], sessionOf)).toEqual([]);
  });
});

describe('the Asks the Workbench watches', () => {
  const target = { agentId: 'ask-agent' };
  const view = buildView('ask');
  const window = buildWindow([view]);
  const facts = (overrides: Partial<AskActivityFacts<typeof target>> = {}): AskActivityFacts<typeof target> =>
    ({ target, attached: true, enabled: true, expanded: true, view, ...overrides });
  const surface = { window, visible: true, compact: false };
  const activity = (overrides: Partial<AskActivityFacts<typeof target>> = {}, over = surface) =>
    askActivityOf([{ owner: 'o', source: 'src' }], () => facts(overrides), over);

  it('lists an enabled, attached, expanded Ask as shown and live', () => {
    expect(activity()).toEqual([{ session: target, visible: true, liveAgentId: 'ask-agent' }]);
  });
  it('asks the facts of each source with its owner', () => {
    const seen: string[] = [];
    askActivityOf([{ owner: 'o1', source: 's1' }, { owner: 'o2', source: 's2' }], (source, owner) => { seen.push(`${source}/${owner}`); return facts(); }, surface);
    expect(seen).toEqual(['s1/o1', 's2/o2']);
  });
  it.each([
    ['is disabled', { enabled: false }],
    ['has no target conversation', { target: undefined }],
    ['is expanded but not attached', { expanded: true, attached: false }],
  ])('leaves out an Ask that %s', (_name, change) => expect(activity(change)).toEqual([]));
  it('keeps a collapsed Ask that is not attached, hidden and not live', () => {
    expect(activity({ expanded: false, attached: false })).toEqual([{ session: target, visible: false, liveAgentId: undefined }]);
  });
  it('hides an Ask while the global Ask surface is hidden, or its view is collapsed', () => {
    expect(activity({}, { ...surface, visible: false })[0]!.visible).toBe(false);
    expect(activity({ view: { ...view, collapsed: true } })[0]!.visible).toBe(false);
  });
  it('hides an Ask whose view is not selected on a compact layout', () => {
    const other = buildView('other');
    expect(activity({}, { ...surface, compact: true, window: buildWindow([other, view], other.id) })[0]!.visible).toBe(false);
    expect(activity({}, { ...surface, compact: true, window: buildWindow([view, other], view.id) })[0]!.visible).toBe(true);
  });
});

describe('restoring an Ask', () => {
  const base = { accessReady: true, hasTarget: false, compositionProtected: false, sourceAvailable: false, independentRestore: false };
  it('needs access', () => expect(askRestoreAllowed({ ...base, accessReady: false, hasTarget: true })).toBe(false));
  it('restores an Ask with a target unless the composition is protected', () => {
    expect(askRestoreAllowed({ ...base, hasTarget: true })).toBe(true);
    expect(askRestoreAllowed({ ...base, hasTarget: true, compositionProtected: true })).toBe(false);
  });
  it('restores from a current source when there is no target', () => {
    expect(askRestoreAllowed({ ...base, sourceAvailable: true })).toBe(true);
    expect(askRestoreAllowed(base)).toBe(false);
  });
  it('under composition protection only an independent restore qualifies', () => {
    expect(askRestoreAllowed({ ...base, sourceAvailable: true, compositionProtected: true })).toBe(false);
    expect(askRestoreAllowed({ ...base, sourceAvailable: true, compositionProtected: true, independentRestore: true })).toBe(true);
    expect(askRestoreAllowed({ ...base, compositionProtected: true, independentRestore: true })).toBe(false);
  });
});

describe('why the Ask launcher is disabled', () => {
  const ready = { hasSource: true, accessReady: true, hasDirectory: true, transitioning: false, controllerOffline: false, hasTarget: false,
    staleness: undefined, hasAgentState: true } as const;
  it('gives no reason without a source, or for a ready source', () => {
    expect(askUnavailableReason({ ...ready, hasSource: false, accessReady: false })).toBeUndefined();
    expect(askUnavailableReason(ready)).toBeUndefined();
  });
  it('waits for access first, whether the directory or the access is missing', () => {
    expect(askUnavailableReason({ ...ready, accessReady: false, transitioning: true })).toBe('waiting for access');
    expect(askUnavailableReason({ ...ready, hasDirectory: false })).toBe('waiting for access');
  });
  it('then waits for the session switch, then names an offline Controller', () => {
    expect(askUnavailableReason({ ...ready, transitioning: true, controllerOffline: true })).toBe('waiting for the session switch to finish');
    expect(askUnavailableReason({ ...ready, controllerOffline: true })).toBe('its Controller is offline');
  });
  it('is never unavailable for an Ask that already has a target, past the first three checks', () => {
    expect(askUnavailableReason({ ...ready, hasTarget: true, staleness: 'view' })).toBeUndefined();
    expect(askUnavailableReason({ ...ready, hasTarget: true, controllerOffline: true })).toBe('its Controller is offline');
  });
  it.each([
    ['inactive', 'waiting for this page to restore its sessions'], ['view', 'this view now shows another session'],
    ['connecting', 'waiting for the session to connect'], ['agent', 'waiting for the session to reattach'],
    ['native', 'waiting for the session to continue its current conversation'],
  ] as const)('explains a %s source', (staleness, reason) => expect(askUnavailableReason({ ...ready, staleness })).toBe(reason));
  it('says connecting while the source has no agent state yet', () => {
    expect(askUnavailableReason({ ...ready, hasAgentState: false })).toBe('waiting for the session to connect');
  });
});
