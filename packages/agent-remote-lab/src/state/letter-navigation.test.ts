// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { otherEndpoint, participantTitle, stackPlan, windowLetterPlan } from './letter-navigation.js';

describe('the other end of a letter', () => {
  it('leads from the sender to the recipient and from the recipient to the sender', () => {
    expect(otherEndpoint('a', 'a', 'b')).toBe('recipient');
    expect(otherEndpoint('b', 'a', 'b')).toBe('sender');
  });
  it('does not lead from a conversation that is not an endpoint', () => expect(otherEndpoint('c', 'a', 'b')).toBeUndefined());
  it('does not lead when an endpoint is unknown or both are the same session', () => {
    expect(otherEndpoint('a', undefined, 'b')).toBeUndefined();
    expect(otherEndpoint('a', 'a', undefined)).toBeUndefined();
    expect(otherEndpoint('a', 'a', 'a')).toBeUndefined();
  });
});

describe('the title of a letter participant', () => {
  it('prefers the favorite title, then the known one, then the address', () => {
    expect(participantTitle({ favorite: 'F', known: 'K', identity: 'I' })).toBe('F');
    expect(participantTitle({ known: 'K', identity: 'I' })).toBe('K');
    expect(participantTitle({ identity: 'I' })).toBe('I');
  });
});

describe('following a letter inside a shared Window', () => {
  it('creates a view for a destination the family does not show, and reuses one it does', () => {
    expect(windowLetterPlan({ existingDestinationId: undefined, endpoint: 'recipient', compact: false }).create).toBe(true);
    expect(windowLetterPlan({ existingDestinationId: 'v', endpoint: 'recipient', compact: false }).create).toBe(false);
  });
  it('selects the destination for the recipient or on a compact layout, and keeps the source otherwise', () => {
    expect(windowLetterPlan({ existingDestinationId: 'v', endpoint: 'recipient', compact: false }).select).toBe('destination');
    expect(windowLetterPlan({ existingDestinationId: 'v', endpoint: 'sender', compact: true }).select).toBe('destination');
    expect(windowLetterPlan({ existingDestinationId: 'v', endpoint: 'sender', compact: false }).select).toBe('origin');
  });
});

describe('following a letter in the stack of a plain layout', () => {
  const base = { senderKey: 's', recipientKey: 'r', sourceKey: 's', rootKey: 'root', path: ['root', 'x', 's', 'r'], expanded: { start: 2, end: 3 } };
  it('does nothing while both endpoints are in the expanded stack', () => expect(stackPlan(base)).toEqual({ kind: 'present' }));
  it('does not count an endpoint on the path but outside the expanded range as present', () => {
    expect(stackPlan({ ...base, expanded: { start: 2, end: 2 } }).kind).not.toBe('present');
    expect(stackPlan({ ...base, expanded: { start: 3, end: 3 } }).kind).not.toBe('present');
  });
  it('selects the other endpoint as a Side of the root when the root is one of them', () => {
    expect(stackPlan({ ...base, rootKey: 's', expanded: { start: 0, end: 0 } })).toEqual({ kind: 'select-side', from: 's', to: 'r' });
    expect(stackPlan({ ...base, rootKey: 'r', expanded: { start: 0, end: 0 } })).toEqual({ kind: 'select-side', from: 'r', to: 's' });
  });
  it('moves the anchor to the deeper endpoint when both are on the path but collapsed', () => {
    expect(stackPlan({ ...base, expanded: { start: 0, end: 1 } })).toEqual({ kind: 'anchor', index: 3 });
    expect(stackPlan({ ...base, path: ['root', 'r', 'x', 's'], expanded: { start: 0, end: 0 } })).toEqual({ kind: 'anchor', index: 3 });
  });
  it('opens the source first when it is an endpoint and neither the root nor the path holds both', () => {
    expect(stackPlan({ ...base, rootKey: 'root', path: ['root', 'r'], expanded: { start: 0, end: 0 } })).toEqual({ kind: 'open-origin', from: 's', to: 'r' });
    expect(stackPlan({ ...base, sourceKey: 'r', rootKey: 'root', path: ['root', 's'], expanded: { start: 0, end: 0 } })).toEqual({ kind: 'open-origin', from: 'r', to: 's' });
  });
  it('opens the sender when the source is neither endpoint', () => {
    expect(stackPlan({ ...base, sourceKey: 'z', rootKey: undefined, path: [], expanded: { start: 0, end: -1 } })).toEqual({ kind: 'open-origin', from: 's', to: 'r' });
  });
  it('has no root to select from without a root', () => {
    expect(stackPlan({ ...base, rootKey: undefined, expanded: { start: 0, end: 0 } }).kind).toBe('anchor');
  });
});
