import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createHostExecutionPolicy } from './execution-policy.js';
import { createAgentHostRuntime } from './host.js';

it('edits a Claude prompt after its turn was rejected by the model API or interrupted, under the workspace policy', async () => {
  const pending: ServerResponse[] = [];
  const f = await nativeFixture((body, response) => {
    const content = body.messages.at(-1).content;
    const texts: string[] = typeof content === 'string' ? [content]
      : content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text);
    const prompt = texts.filter(text => text.endsWith('_PROMPT')).at(-1);
    if (prompt === 'REJECTED_PROMPT') {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'The model is not available on this gateway.' } }));
    } else if (prompt === 'INTERRUPTED_PROMPT') pending.push(response);
    else nativeReply(response, [{ type: 'text', text: 'FIRST_REPLY' }]);
  });
  const provider = new ClaudeAgentProvider({ ...f.options, catalog: createClaudeCatalog(f.options.env, 15000) });
  const host = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: join(f.home, 'succession'), enrollment: true },
    executionPolicy: (await createHostExecutionPolicy({ AGENT_HOST_WORKSPACE: f.cwd }))!,
    registrations: [{ directory: createClaudeSessionDirectory(provider, []), adapter: provider, nativePermissionControl: true }] });
  const authority = { version: 1 as const, origin: 'https://relay.invalid', issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
  const enroll = async (input: unknown) => {
    const result = await host.enrollFromRelay({ method: 'POST', path: '/remote/succession/enrollment', body: JSON.stringify(input) }, { authority, installationId: 'host', successionEnrollmentVersion: 3 });
    return { status: result.status, data: JSON.parse(result.body) };
  };
  try {
    const created = await host.control({ method: 'POST', path: '/remote/create', sessionId: randomUUID(),
      body: JSON.stringify({ providerId: 'claude', operationId: randomUUID(), cwd: f.cwd, model: 'claude-sonnet-4-5-20250929' }) });
    expect(created.status, created.body).toBeLessThan(300);
    const { agentId, nativeSessionId } = JSON.parse(created.body) as { agentId: string; nativeSessionId: string };
    const agent = host.relay.requireAgent(agentId);
    const prompts = new Map<string, { kind: 'native_prefix'; turnId: string; messageId: string }>();
    let ended = 0;
    const unsubscribe = agent.subscribe(update => {
      if (update.type !== 'agent_stream') return;
      const event = update.event;
      if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled') ended++;
      if (event.type === 'timeline' && event.item.type === 'user_message') prompts.set(event.item.text, { kind: 'native_prefix', turnId: event.turnId!, messageId: event.item.messageId! });
    });
    const eligibility = (text: string) => async () => {
      const described = await enroll({ action: 'describe', providerId: 'claude', nativeSessionId, preparation: prompts.get(text) });
      return described.status === 200 ? described.data.eligibility : described.data;
    };
    for (const text of ['FIRST_PROMPT', 'REJECTED_PROMPT']) {
      const before = ended;
      await agent.sendMessage(text);
      await expect.poll(() => ended, { timeout: 20000 }).toBe(before + 1);
    }
    await expect.poll(eligibility('REJECTED_PROMPT'), { timeout: 10000 }).toEqual({ status: 'ready' });

    const requests = f.bodies.length, before = ended;
    await agent.sendMessage('INTERRUPTED_PROMPT');
    await expect.poll(() => f.bodies.length, { timeout: 20000 }).toBeGreaterThan(requests);
    await agent.cancel();
    await expect.poll(() => ended, { timeout: 20000 }).toBe(before + 1);
    await expect.poll(eligibility('INTERRUPTED_PROMPT'), { timeout: 10000 }).toEqual({ status: 'ready' });

    // Editing the rejected prompt branches before it.
    const preparation = prompts.get('REJECTED_PROMPT')!, described = await enroll({ action: 'describe', providerId: 'claude', nativeSessionId, preparation });
    const from = { controllerId: 'host', providerId: 'claude', nativeSessionId };
    const freeze = { version: 3, token: 'freeze', authority, controllerId: 'host', maxProjectionBytes: 2 * 1024 * 1024, associationRevision: 0, lineage: [from], relations: [],
      request: { roleId: described.data.role.id, operationId: randomUUID(), expectedRevision: 1, from, preparation } };
    expect(await enroll({ action: 'prepare', freeze })).toMatchObject({ status: 200, data: { record: { phase: 'ready' } } });
    const committed = await enroll({ action: 'commit', freeze });
    expect(committed).toMatchObject({ status: 200, data: { record: { phase: 'committed', to: { providerId: 'claude' } } } });
    expect(committed.data.record.to.nativeSessionId).not.toBe(nativeSessionId);
    unsubscribe();
  } finally { for (const response of pending) response.destroy(); await host.close(); await f.close(); }
}, 120000);
