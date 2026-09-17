import { describe, expect, it } from 'vitest';
import { decodeClientMessage, decodeServerMessage } from './codec.js';
import { PROTOCOL_VERSION } from './version.js';

describe('native command wire', () => {
  it('accepts directory and invocation messages without accepting native RPC envelopes', () => {
    const message = { protocolVersion: PROTOCOL_VERSION, type: 'execute_command', payload: { requestId: 'r', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'a', commandId: 'native:model', args: '' } };
    expect(decodeClientMessage(JSON.stringify(message)).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({ ...message, payload: { ...message.payload, method: 'native/rpc' } })).status).toBe('rejected');
    expect(decodeClientMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'list_commands', payload: { requestId: 'r', agentId: 'a' } })).status).toBe('ok');
  });
  it('accepts typed directory and command results', () => {
    const message = { protocolVersion: PROTOCOL_VERSION, type: 'command_list', payload: { requestId: 'r', agentId: 'a', commands: [{ id: 's', name: 'skill-name', description: 'A skill', kind: 'skill' }] } };
    expect(decodeServerMessage(JSON.stringify(message)).status).toBe('ok');
    expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, commands: [{ ...message.payload.commands[0], name: '/invalid' }] } })).status).toBe('rejected');
    expect(decodeServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'command_result', payload: { requestId: 'r', agentId: 'a', result: { text: 'Native result' } } })).status).toBe('ok');
  });
  it('carries optional summaries and resource bindings while rejecting provider locators on the public wire', () => {
    const command = { id: 'skill', name: 'inspect', kind: 'skill', description: 'Full description', shortDescription: 'Inspect workspace',
      documentation: { locator: 'skill:inspect', resourceId: 'resource-1', status: 'pending' } };
    const message = (value: unknown) => JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'command_list', payload: { requestId: 'r', agentId: 'a', commands: [value] } });
    expect(decodeServerMessage(message(command)).status).toBe('ok');
    expect(decodeServerMessage(message({ ...command, documentation: 'skill:inspect' })).status).toBe('rejected');
  });
});
