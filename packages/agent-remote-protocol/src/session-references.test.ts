import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AgentToolDetail } from './interactions.js';

it('carries a bounded native session reference separately from display text', () => {
  const detail = { type: 'other', description: 'Agent /root/review: interacted', sessionReference: { nativeSessionId: 'child-id', title: '/root/review' } };
  expect(Value.Check(AgentToolDetail, detail)).toBe(true);
  for (const patch of [{ nativeSessionId: '' }, { title: '' }, { hostId: 'another-host' }, { url: 'https://example.com' }]) {
    expect(Value.Check(AgentToolDetail, { ...detail, sessionReference: { ...detail.sessionReference, ...patch } })).toBe(false);
  }
});

it('carries multiple session references and rejects invalid navigation identities', () => {
  const reference = { nativeSessionId: 'child-id', title: '/root/review' };
  const detail = { type: 'other', description: 'Waiting for agent updates:', sessionReferences: [reference, { nativeSessionId: 'other-id', title: '/root/tests' }] };
  expect(Value.Check(AgentToolDetail, detail)).toBe(true);
  for (const patch of [{ nativeSessionId: '' }, { title: '' }, { url: 'https://example.com' }]) {
    expect(Value.Check(AgentToolDetail, { ...detail, sessionReferences: [{ ...reference, ...patch }] })).toBe(false);
  }
});
