import { expect, it } from 'vitest';
import { OpeningReplyContext } from '@orchardworks/agent-client-web/react';
import { render } from '../test/setup.js';
import { ConversationTimeline } from './ConversationTimeline.js';

// A conversation whose session is not attached yet shows the shape of one, with the newest reply the list knows as its last bubble,
// not a blank body; a Host that is away says so in words instead.
const timeline = (extra: object = {}) => <ConversationTimeline {...({
  state: undefined, sessionStatus: 'connecting', attachingAgentId: 'agent', visible: true, readingPositions: new Map(), actions: {},
  toolsTargetRef: () => {}, toolsCollapsible: false, hasTarget: true, runtimeMutationDisabled: false, ...extra } as never)} />;

it('opens with the shape of a conversation and the newest reply the list knows', async () => {
  const container = await render(<OpeningReplyContext.Provider value="The report is ready.">{timeline()}</OpeningReplyContext.Provider>);
  const bubbles = [...container.querySelectorAll('.agent-timeline-skeleton-bubble')];
  expect(bubbles).toHaveLength(4);
  expect(bubbles.at(-1)?.textContent).toBe('The report is ready.');
  expect(container.textContent).not.toContain('No timeline activity');
});

it('opens with the shape alone when the list has no reply', async () => {
  const container = await render(timeline());
  expect(container.querySelectorAll('.agent-timeline-skeleton-bubble')).toHaveLength(4);
  expect(container.textContent).toBe('');
});

it('says in words that a Host is away instead of showing the shape', async () => {
  const container = await render(timeline({ loadingNotice: { title: 'Host is offline', detail: 'Waiting for it.' } }));
  expect(container.querySelector('.agent-timeline-skeleton')).toBeNull();
  expect(container.textContent).toContain('Host is offline');
});
