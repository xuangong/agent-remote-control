import { createElement } from 'react';
import { expect, it } from 'vitest';
import { hiddenConversationUnchanged } from './conversation-props.js';

const target = () => ({ hostId: 'h', providerId: 'p', nativeSessionId: 's', title: 'One' });
const props = (extra: Record<string, unknown> = {}) => ({ visible: false, active: true, folded: false, target: target(), entries: [target()],
  attachedSession: { ...target(), agentId: 'a' }, onSessionBound: () => {}, controls: createElement('span'), ...extra });

it('keeps a hidden conversation whose props were only rebuilt', () => {
  expect(hiddenConversationUnchanged(props(), props())).toBe(true);
});

it('renders a conversation that is or becomes shown', () => {
  expect(hiddenConversationUnchanged(props({ visible: true }), props({ visible: true }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ visible: true }))).toBe(false);
  expect(hiddenConversationUnchanged(props({ visible: true }), props())).toBe(false);
  // Visibility left to its default means shown.
  expect(hiddenConversationUnchanged(props({ visible: undefined }), props({ visible: undefined }))).toBe(false);
});

it('renders a hidden conversation whose lifecycle changed', () => {
  expect(hiddenConversationUnchanged(props(), props({ folded: true }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ active: false }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ target: { ...target(), nativeSessionId: 'other' } }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ attachedSession: undefined }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ mutationBlocked: true }))).toBe(false);
  expect(hiddenConversationUnchanged(props(), props({ entries: [target(), target()] }))).toBe(false);
});

it('compares objects other than plain data by identity', () => {
  class Replica {}
  const replica = new Replica();
  expect(hiddenConversationUnchanged(props({ replica }), props({ replica }))).toBe(true);
  expect(hiddenConversationUnchanged(props({ replica }), props({ replica: new Replica() }))).toBe(false);
});
