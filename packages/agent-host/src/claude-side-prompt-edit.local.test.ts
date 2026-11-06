import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createHostExecutionPolicy } from './execution-policy.js';
import { createAgentHostRuntime } from './host.js';
import { SessionReferenceStore } from './session-reference.js';

const texts = (message: { content: unknown } | undefined): string[] => typeof message?.content === 'string' ? [message.content]
  : Array.isArray(message?.content) ? message.content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text) : [];
const toolResults = (body: { messages: Array<{ content: unknown }> }): string => JSON.stringify(body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  .filter((block: { type: string }) => block.type === 'tool_result'));

it('edits a prompt in a Claude Side whose branch keeps reading the source as the Side', async () => {
  const f = await nativeFixture((body, response) => {
    if (toolResults(body) !== '[]') return nativeReply(response, [{ type: 'text', text: 'SIDE_READ_DONE' }]);
    const prompt = texts(body.messages.at(-1)).filter(text => text.endsWith('_PROMPT')).at(-1);
    if (prompt === 'EDITED_SIDE_PROMPT') return nativeReply(response, [{ type: 'tool_use', id: 'source-read', name: 'mcp__agent_host__read_source_session', input: { query: 'SOURCE_ANSWER' } }]);
    nativeReply(response, [{ type: 'text', text: prompt === 'SOURCE_PROMPT' ? 'SOURCE_ANSWER' : 'SIDE_REPLY' }]);
  });
  const provider = new ClaudeAgentProvider({ ...f.options, catalog: createClaudeCatalog(f.options.env, 15000) });
  const references = new SessionReferenceStore(join(f.home, 'references'), 'claude');
  const host = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: join(f.home, 'succession'), enrollment: true },
    executionPolicy: (await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: f.cwd }))!,
    registrations: [{ directory: createClaudeSessionDirectory(provider, [], undefined, references), adapter: provider, nativePermissionControl: true }] });
  const authority = { version: 1 as const, origin: 'https://relay.invalid', issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
  const enroll = async (input: unknown) => {
    const result = await host.enrollFromRelay({ method: 'POST', path: '/remote/succession/enrollment', body: JSON.stringify(input) }, { authority, installationId: 'host', successionEnrollmentVersion: 3 });
    return { status: result.status, data: JSON.parse(result.body) };
  };
  const unsubscribes: Array<() => void> = [];
  /** Sends prompts one turn at a time, approving Host tool calls, and remembers each prompt's native identity. */
  const conversation = (agentId: string) => {
    const agent = host.relay.requireAgent(agentId);
    const prompts = new Map<string, { kind: 'native_prefix'; turnId: string; messageId: string }>();
    let ended = 0;
    unsubscribes.push(agent.subscribe(update => {
      if (update.type !== 'agent_stream') return;
      const event = update.event;
      if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled') ended++;
      if (event.type === 'interaction_requested' && event.request.kind === 'tool_approval') void agent.respondToInteraction(event.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
      if (event.type === 'timeline' && event.item.type === 'user_message') prompts.set(event.item.text, { kind: 'native_prefix', turnId: event.turnId!, messageId: event.item.messageId! });
    }));
    return { prompts, async send(text: string) {
      const before = ended;
      await agent.sendMessage(text);
      await expect.poll(() => ended, { timeout: 20000 }).toBe(before + 1);
    } };
  };
  const create = async (sourceNativeSessionId?: string) => {
    const created = await host.control({ method: 'POST', path: '/remote/create', sessionId: randomUUID(),
      body: JSON.stringify({ providerId: 'claude', operationId: randomUUID(), cwd: f.cwd, model: 'claude-sonnet-4-5-20250929', ...(sourceNativeSessionId ? { sourceNativeSessionId } : {}) }) });
    expect(created.status, created.body).toBeLessThan(300);
    return JSON.parse(created.body) as { agentId: string; nativeSessionId: string };
  };
  try {
    const source = await create();
    await conversation(source.agentId).send('SOURCE_PROMPT');
    const side = await create(source.nativeSessionId), reader = conversation(side.agentId);
    for (const text of ['FIRST_SIDE_PROMPT', 'SECOND_SIDE_PROMPT']) await reader.send(text);

    const from = { controllerId: 'host', providerId: 'claude', nativeSessionId: side.nativeSessionId };
    const preparation = reader.prompts.get('SECOND_SIDE_PROMPT')!;
    await expect.poll(async () => {
      const described = await enroll({ action: 'describe', providerId: 'claude', nativeSessionId: side.nativeSessionId, preparation });
      return described.status === 200 ? described.data.eligibility : described.data;
    }, { timeout: 10000 }).toEqual({ status: 'ready' });
    const described = await enroll({ action: 'describe', providerId: 'claude', nativeSessionId: side.nativeSessionId, preparation });
    const freeze = { version: 3, token: 'freeze', authority, controllerId: 'host', maxProjectionBytes: 2 * 1024 * 1024, associationRevision: described.data.associationRevision, lineage: [from],
      relations: [{ relationId: 'relation', kind: 'side', readerRef: from, sourceRef: { ...from, nativeSessionId: source.nativeSessionId }, linked: true, revision: 0 }],
      request: { roleId: described.data.role.id, operationId: randomUUID(), expectedRevision: 1, from, preparation } };
    const prepared = await enroll({ action: 'prepare', freeze });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({ status: 200, data: { record: { phase: 'ready' } } });
    const committed = await enroll({ action: 'commit', freeze });
    expect(committed).toMatchObject({ status: 200, data: { record: { phase: 'committed', to: { providerId: 'claude' } } } });
    expect((await enroll({ action: 'release', freeze })).status).toBe(200);
    const branch = committed.data.record.to.nativeSessionId as string;
    expect(branch).not.toBe(side.nativeSessionId);

    const attached = await host.control({ method: 'POST', path: '/remote/attach', sessionId: randomUUID(), body: JSON.stringify({ providerId: 'claude', nativeSessionId: branch }) });
    expect(attached.status, attached.body).toBe(200);
    const requests = f.bodies.length;
    await conversation(JSON.parse(attached.body).agentId).send('EDITED_SIDE_PROMPT');
    const edited = f.bodies.slice(requests);
    // The branch holds the Side's conversation before the edited prompt, with its source instructions and tool.
    expect(edited[0].messages.flatMap(texts)).toEqual(expect.arrayContaining(['FIRST_SIDE_PROMPT', 'EDITED_SIDE_PROMPT']));
    expect(edited[0].messages.flatMap(texts)).not.toContain('SECOND_SIDE_PROMPT');
    expect(JSON.stringify(edited[0].system)).toContain('independent side conversation');
    expect(edited[0].tools.map((tool: { name: string }) => tool.name)).toContain('mcp__agent_host__read_source_session');
    expect(toolResults(edited.at(-1))).toContain('SOURCE_ANSWER');
    expect(await references.list()).toEqual([{ nativeSessionId: side.nativeSessionId, sourceNativeSessionId: source.nativeSessionId }]);
  } finally { for (const unsubscribe of unsubscribes) unsubscribe(); await host.close(); await f.close(); }
}, 120000);
