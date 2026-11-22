import { describe, expect, it, vi } from 'vitest';
import { buildSessionViewContext } from '../../test/session-view-context.js';
import { ownerInputContribution, type OwnerInputContributionInputs } from './owner-input.js';

const present = (overrides: Partial<Record<keyof OwnerInputContributionInputs, unknown>> = {}) => ownerInputContribution({
  questionDrafts: {}, setPendingGroupInputs: vi.fn(), setQuestionDrafts: vi.fn(), ...overrides,
} as unknown as OwnerInputContributionInputs)(buildSessionViewContext()).props!;

describe('the owner input of a session view', () => {
  it('shows the drafts of the answers to this session only', () => {
    expect(present({ questionDrafts: { 'agent-s1': { q1: { text: 'a' } } } }).questionDrafts).toEqual({ q1: { text: 'a' } });
    expect(present({ questionDrafts: { 'agent-other': { q1: { text: 'a' } } } }).questionDrafts).toEqual({});
  });

  it('stores a changed draft under its session and request', () => {
    const setQuestionDrafts = vi.fn();
    present({ setQuestionDrafts }).onQuestionDraftChange!('q2', { text: 'b' } as never);
    const update = setQuestionDrafts.mock.calls[0]![0] as (current: object) => object;
    expect(update({ 'agent-s1': { q1: 'x' }, 'agent-other': { q9: 'y' } })).toEqual({ 'agent-s1': { q1: 'x', q2: { text: 'b' } }, 'agent-other': { q9: 'y' } });
  });

  it('counts the pending inputs of the view and keeps the same object when the count did not change', () => {
    const setPendingGroupInputs = vi.fn();
    present({ setPendingGroupInputs }).onPendingInputChange!(2);
    const update = setPendingGroupInputs.mock.calls[0]![0] as (current: Record<string, number>) => Record<string, number>;
    const same = { 'view-s1': 2 };
    expect(update(same)).toBe(same);
    expect(update({ 'view-s1': 1, other: 3 })).toEqual({ 'view-s1': 2, other: 3 });
  });
});
