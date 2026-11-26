// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createReplicaState } from '@orchardworks/agent-client';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

it('shows the shape of a conversation, and never that it is empty, until its first page or the device copy arrived', async () => {
  const container = await render(<AgentTimeline state={createReplicaState()} />);
  expect(container.querySelector('.agent-timeline-skeleton')).not.toBeNull();
  expect(container.querySelector('.agent-timeline-empty')).toBeNull();
  expect(container.textContent).not.toContain('No timeline activity');
});

it('says nothing happened only when a loaded timeline has no rows', async () => {
  const base = createReplicaState();
  const container = await render(<AgentTimeline state={{ ...base, timeline: { ...base.timeline, initialized: true, epoch: 'e', nextSeq: 1 } }} />);
  expect(container.querySelector('.agent-timeline-skeleton')).toBeNull();
  expect(container.querySelector('.agent-timeline-empty')?.textContent).toBe('No timeline activity.');
});
