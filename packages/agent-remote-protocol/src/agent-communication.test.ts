import { expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AgentTimelineItem } from './timeline.js';

it('validates attributed agent communication without allowing private native payloads', () => {
  const item = { type: 'agent_communication', messageId: 'message', sender: '/root', recipient: '/root/review', text: 'Review this.' };
  expect(Value.Check(AgentTimelineItem, item)).toBe(true);
  expect(Value.Check(AgentTimelineItem, { ...item, sender: '' })).toBe(false);
  expect(Value.Check(AgentTimelineItem, { ...item, encryptedContent: 'private' })).toBe(false);
});
