// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { expect, it } from 'vitest';
import { buildRestoredReplica } from '@orchardworks/agent-client/testing';
import type { AgentReplica } from '@orchardworks/agent-client';
import { render } from '../test/setup.js';
import { AgentTimeline } from './AgentTimeline.js';

function Screen({ replica }: { replica: AgentReplica }) {
  return <AgentTimeline state={useSyncExternalStore(listener => replica.subscribe(listener), () => replica.getState())} />;
}

it('draws the rows of a restored state by item key on its first render, with no connection and no loading notice', async () => {
  const container = await render(<Screen replica={buildRestoredReplica({ rows: 3 })} />);
  expect(Array.from(container.querySelectorAll<HTMLElement>('.agent-timeline-entry')).map(node => node.dataset.entryKey)).toEqual(['m1', 'm2', 'm3']);
  expect(container.querySelector('.agent-timeline-empty')).toBeNull();
});
