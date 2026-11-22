import { describe, expect, it, vi } from 'vitest';
import { buildView } from '../../test/window-builders.js';
import { buildSessionViewContext } from '../../test/session-view-context.js';
import { replicaState } from '../../test/fixtures.js';
import { traceContribution, type TraceContributionInputs } from './trace.js';

function setup(overrides: Partial<Record<keyof TraceContributionInputs, unknown>> = {}, facts = {}) {
  const operate = vi.fn(), setTraceNavigation = vi.fn(), showView = vi.fn(), traceRequestCounter = { current: 4 };
  const props = traceContribution({ letterReveals: {}, setTraceNavigation, showView, state: replicaState, traceRequest: undefined, traceRequestCounter, windowWorkspace: { authority: { operate } }, ...overrides } as unknown as TraceContributionInputs)(buildSessionViewContext(facts)).props!;
  return { props, operate, setTraceNavigation, showView, traceRequestCounter };
}

describe('the Trace of a session view', () => {
  it('opens an entry in the Trace for the timeline of this session, with a new request', () => {
    const { props, setTraceNavigation, showView, traceRequestCounter } = setup();
    props.onInspectEntry!('entry-1');
    expect(setTraceNavigation).toHaveBeenCalledWith({ scope: JSON.stringify(['agent-1', 'epoch-1']), key: 'entry-1', view: 'trace', requestId: 5 });
    expect(traceRequestCounter.current).toBe(5);
    expect(showView).toHaveBeenCalledWith('trace');
  });

  it('selects the Window view first', () => {
    const { props, operate } = setup({}, { view: buildView('v1') });
    props.onInspectEntry!('entry-1');
    expect(operate).toHaveBeenCalledWith({ type: 'view.select', viewId: 'v1' });
    const none = setup();
    none.props.onInspectEntry!('entry-1');
    expect(none.operate).not.toHaveBeenCalled();
  });

  it('reveals the entry a letter asked for, else the Trace request for this conversation', () => {
    const letter = { key: 'a', requestId: 1 }, request = { view: 'workbench', key: 'b', requestId: 2 };
    expect(setup({ letterReveals: { 'agent-s1': letter }, traceRequest: request }).props.revealEntry).toBe(letter);
    expect(setup({ traceRequest: request }).props.revealEntry).toBe(request);
    expect(setup({ traceRequest: { ...request, view: 'trace' } }).props.revealEntry).toBeUndefined();
    expect(setup({ traceRequest: request, state: { agent: { id: 'other' } } }).props.revealEntry).toBeUndefined();
  });

  it('inspects and reveals nothing in Bot mode', () => {
    const { props } = setup({ letterReveals: { 'agent-s1': { key: 'a' } } }, { botPresentation: true });
    expect(props).toEqual({ onInspectEntry: undefined, revealEntry: undefined });
  });
});
