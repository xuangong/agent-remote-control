import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { query, type ElicitationRequest } from '@anthropic-ai/claude-agent-sdk';
import { expect, it } from 'vitest';
import { ClaudeAgentSession } from './session.js';
import { nativeFixture, nativeReply } from './test-utils/native-fixture.js';
import { writeMcpFormServer } from './test-utils/mcp-elicitation.js';

for (const action of ['submit', 'decline', 'cancel'] as const) it(`characterizes native MCP elicitation through the public callback with ${action}`, async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'native-form-tool', name: 'mcp__fixture__collect_preferences', input: {} }]
    : [{ type: 'text', text: 'FORM_COMPLETE' }]));
  const { resultPath, serverPath } = await writeMcpFormServer(fixture.cwd, { type: 'object', required: ['name'], properties: {
    name: { type: 'string', minLength: 2 }, enabled: { type: 'boolean', default: false }
  } });
  const requests: ElicitationRequest[] = [];
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, {
    ...fixture.options, query: (args) => query({ ...args, options: { ...args.options,
      mcpServers: { fixture: { command: process.execPath, args: [serverPath] } }, strictMcpConfig: true,
      onElicitation: async (request) => {
        requests.push(request);
        return action === 'submit' ? { action: 'accept', content: { name: 'Jane', enabled: false } } : { action };
      } } }),
  });
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('COLLECT_FORM');
    await expect.poll(() => events.some((event) => event.type === 'interaction_requested')).toBe(true);
    const tool = events.find((event) => event.type === 'interaction_requested' && event.request.kind === 'tool_approval');
    if (tool) await session.respondToInteraction(tool.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await expect.poll(() => events.some((event) => event.type === 'turn_completed')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.requestedSchema?.properties).toMatchObject({ name: { type: 'string', minLength: 2 } });
    const nativeResult = JSON.parse(await readFile(resultPath, 'utf8'));
    expect(nativeResult.result.action).toBe(action === 'submit' ? 'accept' : action);
    if (action === 'submit') expect(nativeResult.result.content).toEqual({ name: 'Jane', enabled: false });
    expect(session.capabilities.interactions.form).not.toBe(true);
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);

it('characterizes native loss of unsupported constraints and sensitive markers before onElicitation', async () => {
  let calls = 0;
  const fixture = await nativeFixture((_body, response) => nativeReply(response, ++calls === 1
    ? [{ type: 'tool_use', id: 'native-schema-tool', name: 'mcp__fixture__collect_preferences', input: {} }]
    : [{ type: 'text', text: 'SCHEMA_PROBE_COMPLETE' }]));
  const { serverPath } = await writeMcpFormServer(fixture.cwd, { type: 'object', properties: {
    text: { type: 'string', writeOnly: true, sensitive: true, isSecret: true, pattern: '^a', minLength: 2, default: 'example' },
    number: { type: 'number', multipleOf: 2, minimum: 1 },
  } });
  const requests: ElicitationRequest[] = [];
  const session = await ClaudeAgentSession.open({ sessionId: randomUUID(), cwd: fixture.cwd, model: 'claude-sonnet-4-5-20250929' }, {
    ...fixture.options, query: (args) => query({ ...args, options: { ...args.options,
      mcpServers: { fixture: { command: process.execPath, args: [serverPath] } }, strictMcpConfig: true,
      onElicitation: async (request) => { requests.push(request); return { action: 'decline' }; } } }),
  });
  const events: any[] = [];
  const pump = (async () => { for await (const item of session.observe()) if (item.type === 'observation') events.push(item.event); })();
  try {
    await session.sendMessage('PROBE_NATIVE_SCHEMA');
    await expect.poll(() => events.some((event) => event.type === 'interaction_requested')).toBe(true);
    const permission = events.find((event) => event.type === 'interaction_requested');
    await session.respondToInteraction(permission.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await expect.poll(() => events.some((event) => event.type === 'turn_completed')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.requestedSchema?.properties).toEqual({ text: { type: 'string', minLength: 2, default: 'example' }, number: { type: 'number', minimum: 1 } });
  } finally { await session.dispose(); await pump; await fixture.close(); }
}, 10000);
