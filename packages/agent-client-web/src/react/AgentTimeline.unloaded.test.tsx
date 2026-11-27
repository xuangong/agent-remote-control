// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { createReplicaState } from '@orchardworks/agent-client';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';
import { OpeningReplyContext } from './TimelineSkeleton.js';

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

it('shows the newest reply the list knows as the last bubble of the shape, in words, while the rest loads', async () => {
  const container = await render(<OpeningReplyContext.Provider value="Done: the report is in the folder.">
    <AgentTimeline state={createReplicaState()} /></OpeningReplyContext.Provider>);
  const bubbles = [...container.querySelectorAll('.agent-timeline-skeleton-bubble')];
  expect(bubbles).toHaveLength(4);
  expect(bubbles.at(-1)?.textContent).toBe('Done: the report is in the folder.');
  expect(bubbles.slice(0, -1).every(bubble => bubble.textContent === '' && bubble.getAttribute('aria-hidden') === 'true')).toBe(true);
});
