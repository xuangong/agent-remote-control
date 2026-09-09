import { CodexEventProjector } from '@borgee/agent-provider-codex';
import { PROTOCOL_VERSION, encodeAgentStreamMessage } from '@borgee/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

describe('Codex projected wire events', () => {
  it.each([
    [
      { type: 'commandExecution', id: 'command-1', status: 'inProgress' },
      { type: 'other', description: 'Run a command' },
    ],
    [
      { type: 'webSearch', id: 'search-1', status: 'completed' },
      { type: 'other', description: 'Web search' },
    ],
  ])('encodes a legal fallback when a native tool item omits required detail', (item, detail) => {
    const projector = new CodexEventProjector('thread-1');
    const observation = projector.projectNotification('item/started', {
      threadId: 'thread-1', turnId: 'turn-1', item,
    });
    if (!observation || observation.event.type !== 'timeline') {
      throw new Error('Expected a projected Timeline observation.');
    }

    expect(observation.event.item).toMatchObject({ type: 'tool_call', detail });
    expect(encodeAgentStreamMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'agent_stream',
      payload: {
        agentId: 'agent-1', epoch: 'epoch-1', seq: 1,
        timestamp: '2026-09-03T00:00:00.000Z',
        event: {
          type: 'timeline', providerId: 'codex', turnId: 'turn-1',
          item: observation.event.item, resources: [],
        },
      },
    })).toMatchObject({ status: 'ok' });
  });
});
