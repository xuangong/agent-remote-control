import { connect } from 'node:net';

import type {
  AgentCapabilities,
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  ProviderStreamItem,
} from '@orchardworks/agent-provider-sdk';
import {
  decodeAgentSessionResponse,
  decodeAgentSnapshot,
  decodeHistoryPage,
  decodeProviderListResponse,
  decodeServerMessage,
  encodeCreateAgentRequest,
  encodeResumeAgentRequest,
} from '@orchardworks/agent-remote-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { type RawData } from 'ws';

import {
  AgentReplica,
  HttpWebSocketTransport,
  RemoteSessionClient,
  type RemoteProtocolObservation,
  type RemoteSessionStatus,
  type WebSocketLike,
} from '../../../agent-remote-web/src/headless.js';
import type { AgentRemoteRelay } from '../relay.js';
import { createAgentRemoteRelay } from '../relay.js';
import type { AgentRemoteHttpServer } from './http-server.js';
import { createAgentRemoteHttpServer } from './http-server.js';
import type { AgentRemoteWebSocketAuthorizer } from './websocket-stream.js';

const capabilities: AgentCapabilities = {
  history: true,
  sendMessage: true,
  steer: false,
  cancel: false,
  readResource: false,
  interactions: { question: true, planApproval: true, toolApproval: true },
};

const closeables: Array<() => Promise<void>> = [];

const interactionCases: Array<{
  kind: AgentInteractionRequest['kind'];
  request: AgentInteractionRequest;
  response: AgentInteractionResponse;
  invalid: AgentInteractionResponse;
  malformed: unknown;
}> = [
  {
    kind: 'question',
    request: {
      kind: 'question', requestId: 'question-one',
      questions: [{
        questionId: 'runtime', header: 'Runtime', prompt: 'Choose a runtime.', required: true,
        selection: 'single', options: [{ value: 'web', label: 'Web' }],
        allowCustomText: false, allowDismiss: false,
      }],
    },
    response: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web'] }] },
    invalid: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['unknown'] }] },
    malformed: { kind: 'question', answers: [{ questionId: 'runtime', selectedValues: ['web', 'web'] }] },
  },
  {
    kind: 'plan_approval',
    request: {
      kind: 'plan_approval', requestId: 'plan-one', plan: 'Update the documentation.',
      allowedActions: ['reject', 'approve_and_resume'],
    },
    response: { kind: 'plan_approval', action: 'reject', feedback: 'Include recovery examples.' },
    invalid: { kind: 'plan_approval', action: 'approve' },
    malformed: { kind: 'plan_approval', action: 'approve', feedback: 'Not valid on approval.' },
  },
  {
    kind: 'tool_approval',
    request: {
      kind: 'tool_approval', requestId: 'tool-one', toolCallId: 'call-one', toolName: 'read',
      summary: 'Read the documentation.', detail: { type: 'read', filePath: '/workspace/guide.md' },
      allowedDecisions: ['allow'], allowScopes: ['once'],
    },
    response: { kind: 'tool_approval', decision: 'allow', scope: 'once' },
    invalid: { kind: 'tool_approval', decision: 'allow', scope: 'session' },
    malformed: { kind: 'tool_approval', decision: 'allow' },
  },
];

interactionCases.push(
  {
    kind: 'form',
    request: { kind: 'form', requestId: 'form-one', title: 'Count', message: '', fields: [{ type: 'number', fieldId: 'count', label: 'Count', required: true, integer: true, minimum: 1, maximum: 3 }] },
    response: { kind: 'form', action: 'submit', values: { count: 2 } },
    invalid: { kind: 'form', action: 'submit', values: { count: 4 } },
    malformed: { kind: 'form', action: 'submit', values: { count: { nested: true } } },
  },
  {
    kind: 'permission_approval',
    request: { kind: 'permission_approval', requestId: 'permission-one', summary: 'Read project', permissions: [{ resource: 'filesystem', access: 'read', target: '/workspace' }], allowScopes: ['turn'] },
    response: { kind: 'permission_approval', decision: 'allow', scope: 'turn' },
    invalid: { kind: 'permission_approval', decision: 'allow', scope: 'session' },
    malformed: { kind: 'permission_approval', decision: 'allow' },
  },
  {
    kind: 'external_action',
    request: { kind: 'external_action', requestId: 'external-one', title: 'Authenticate', message: 'Complete authentication', url: 'https://example.com/auth' },
    response: { kind: 'external_action', action: 'completed' },
    invalid: { kind: 'form', action: 'cancel' },
    malformed: { kind: 'external_action', action: 'navigate' },
  },
);

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((close) => close()));
});

describe('Agent Remote HTTP transport', () => {
  it('serves the strict protocol Provider list response', async () => {
    const { url } = await start();
    const response = await fetch(`${url}/v1/providers?protocolVersion=1.5.0`);
    const json = await response.text();

    expect(response.status).toBe(200);
    expect(decodeProviderListResponse(json)).toEqual({
      status: 'ok',
      value: {
        protocolVersion: '1.5.0',
        type: 'provider_list',
        payload: { providers: [{ providerId: 'fake', displayName: 'Fake Agent' }] },
      },
    });
    const value = JSON.parse(json) as Record<string, unknown>;
    expect(decodeProviderListResponse(JSON.stringify({ ...value, providers: [] }))).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'invalid_shape', path: '/providers' }],
    });
  });

  it('creates an Agent and serves its independent Snapshot by relay agentId', async () => {
    const { url } = await start();
    const body = encodeCreateAgentRequest({
      protocolVersion: '1.5.0', type: 'create_agent',
      payload: {
        requestId: 'create-1', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent-http', providerId: 'fake',
        config: { sessionId: 'provider-session-http', cwd: '/workspace' },
      },
    });
    if (body.status !== 'ok') throw new Error('Create fixture did not encode.');

    const createResponse = await fetch(`${url}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body.json,
    });
    const created = decodeAgentSessionResponse(await createResponse.text());
    const snapshotResponse = await fetch(`${url}/v1/sessions/agent-http/snapshot?protocolVersion=1.5.0`);
    const snapshot = decodeAgentSnapshot(await snapshotResponse.text());

    expect(createResponse.status).toBe(201);
    expect(created).toMatchObject({
      status: 'ok',
      value: {
        type: 'agent_session',
        payload: {
          requestId: 'create-1', agentId: 'agent-http', providerId: 'fake',
          sessionId: 'provider-session-http',
        },
      },
    });
    expect(snapshotResponse.status).toBe(200);
    expect(snapshot).toMatchObject({
      status: 'ok',
      value: { type: 'agent_snapshot', payload: { id: 'agent-http', runtimeInfo: { sessionId: 'provider-session-http' } } },
    });
    if (snapshot.status === 'ok') {
      expect(snapshot.value.payload).not.toHaveProperty('timeline');
      expect(snapshot.value.payload).not.toHaveProperty('epoch');
    }
  });

  it('resumes an Agent and fetches Timeline pages independently of Snapshot', async () => {
    const history = [timelineObservation('history-1', 'Recovered output.', 1, 'history')];
    const { url } = await start(history);
    const body = encodeResumeAgentRequest({
      protocolVersion: '1.5.0', type: 'resume_agent',
      payload: {
        requestId: 'resume-1', agentId: 'agent-resumed',
        persistence: { providerId: 'fake', sessionId: 'provider-session-resumed', opaque: 'resume-token' },
      },
    });
    if (body.status !== 'ok') throw new Error('Resume fixture did not encode.');

    const resumeResponse = await fetch(`${url}/v1/sessions/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body.json,
    });
    const resumeJson = await resumeResponse.text();
    const timelineResponse = await fetch(
      `${url}/v1/sessions/agent-resumed/timeline?protocolVersion=1.5.0&requestId=tail-1&direction=tail&limit=10`,
    );
    const timeline = decodeHistoryPage(await timelineResponse.text());

    expect(resumeResponse.status).toBe(200);
    expect(decodeAgentSessionResponse(resumeJson)).toMatchObject({
      status: 'ok', value: { payload: { requestId: 'resume-1', agentId: 'agent-resumed' } },
    });
    expect(timelineResponse.status).toBe(200);
    expect(timeline).toMatchObject({
      status: 'ok',
      value: {
        type: 'timeline_page',
        payload: {
          requestId: 'tail-1', agentId: 'agent-resumed', direction: 'tail',
          entries: [{ seqStart: 1, seqEnd: 1, item: { type: 'assistant_message', text: 'Recovered output.' } }],
        },
      },
    });
  });

  it('rejects non-exact versions and malformed ingress with codec-valid protocol errors', async () => {
    const { url } = await start();

    const snapshotResponse = await fetch(`${url}/v1/sessions/missing/snapshot?protocolVersion=1.0.1`);
    const createResponse = await fetch(`${url}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: '1.0.1', type: 'create_agent', payload: {} }),
    });

    expect(snapshotResponse.status).toBe(400);
    expect(decodeServerMessage(await snapshotResponse.text())).toMatchObject({
      status: 'ok', value: { type: 'protocol_error', payload: { code: 'incompatible_protocol_version', recoverable: false } },
    });
    expect(createResponse.status).toBe(400);
    expect(decodeServerMessage(await createResponse.text())).toMatchObject({
      status: 'ok', value: { type: 'protocol_error', payload: { code: 'incompatible_protocol_version', recoverable: false } },
    });
  });

  it('classifies invalid path escapes and oversized bodies without disabling later requests', async () => {
    const { url } = await start();
    const escaped = await fetch(`${url}/v1/sessions/%/snapshot?protocolVersion=1.5.0`);
    const oversized = await fetch(`${url}/v1/sessions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(1_048_577),
    });

    expect(escaped.status).toBe(400);
    expect(decodeServerMessage(await escaped.text())).toMatchObject({
      status: 'ok', value: { type: 'protocol_error', payload: { code: 'invalid_path' } },
    });
    expect(oversized.status).toBe(400);
    expect(decodeServerMessage(await oversized.text())).toMatchObject({
      status: 'ok', value: { type: 'protocol_error', payload: { code: 'request_body_too_large' } },
    });
  });
});

describe('Agent Remote WebSocket transport', () => {
  it('does not bind or retain Agent events before exact negotiation', async () => {
    const { relay, url } = await start();
    await relay.createAgent(createRequest('agent-unnegotiated', 'provider-session-unnegotiated'));
    const agent = relay.requireAgent('agent-unnegotiated');
    const subscribe = vi.spyOn(agent, 'subscribe');
    const requireAgent = vi.spyOn(relay, 'requireAgent');
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-unnegotiated/events`);

    for (let index = 0; index < 10_000; index += 1) {
      agent.replaceTimeline(`epoch-unnegotiated-${index}`);
    }

    expect(requireAgent).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();

    const negotiated = collectMessages(socket, 2);
    socket.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    const messages = (await negotiated).map((json) => decodeServerMessage(json));

    expect(requireAgent).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(messages).toMatchObject([
      { status: 'ok', value: { type: 'negotiated' } },
      { status: 'ok', value: { type: 'agent_snapshot', payload: { id: 'agent-unnegotiated' } } },
    ]);
    socket.close();
  });

  it('denies anonymous attachment when no authorizer is configured', async () => {
    const { relay, url } = await start([], null);
    await relay.createAgent(createRequest('agent-private', 'provider-session-private'));

    await expect(openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-private/events`))
      .rejects.toThrow('401');
  });

  it('propagates the authenticated principal and denies unauthorized resource reads before the Agent', async () => {
    const authorizationChecks: Array<{ subject: string; agentId: string; action: string }> = [];
    const authorizer: AgentRemoteWebSocketAuthorizer = {
      authenticate: () => ({ subject: 'user-7' }),
      authorize({ principal, agentId, action }) {
        authorizationChecks.push({ subject: principal.subject, agentId, action });
        return action === 'attach';
      },
    };
    const { relay, url } = await start([], authorizer);
    await relay.createAgent(createRequest('agent-protected', 'provider-session-protected'));
    const readResource = vi.spyOn(relay.requireAgent('agent-protected'), 'readResource');
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-protected/events`);
    const negotiated = collectMessages(socket, 2);
    socket.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    await negotiated;

    const rejected = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.5.0', type: 'resource_request',
      payload: { requestId: 'resource-denied', agentId: 'agent-protected', resourceId: 'resource-1' },
    }));

    expect(decodeServerMessage((await rejected)[0] as string)).toMatchObject({
      status: 'ok',
      value: {
        type: 'protocol_error',
        payload: { requestId: 'resource-denied', code: 'forbidden', recoverable: true },
      },
    });
    expect(readResource).not.toHaveBeenCalled();
    expect(authorizationChecks).toEqual([
      { subject: 'user-7', agentId: 'agent-protected', action: 'attach' },
      { subject: 'user-7', agentId: 'agent-protected', action: 'read_resource' },
    ]);
    socket.close();
  });

  it('requires exact negotiation before Snapshot or session commands', async () => {
    const { relay, url } = await start();
    await relay.createAgent(createRequest('agent-ws', 'provider-session-ws'));
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-ws/events`);

    const negotiationRequired = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.5.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-early', agentIds: ['agent-ws'] },
    }));
    expect(decodeServerMessage((await negotiationRequired)[0] as string)).toMatchObject({
      status: 'ok', value: { type: 'protocol_error', payload: { code: 'negotiation_required' } },
    });

    const rejectedVersion = collectMessages(socket, 1);
    socket.send(JSON.stringify({ protocolVersion: '1.0.1', type: 'negotiate' }));
    expect(decodeServerMessage((await rejectedVersion)[0] as string)).toMatchObject({
      status: 'ok',
      value: { type: 'protocol_error', payload: { code: 'incompatible_protocol_version', recoverable: false } },
    });

    const accepted = collectMessages(socket, 2);
    socket.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    const messages = (await accepted).map((json) => decodeServerMessage(json));
    expect(messages).toMatchObject([
      { status: 'ok', value: { type: 'negotiated' } },
      { status: 'ok', value: { type: 'agent_snapshot', payload: { id: 'agent-ws' } } },
    ]);
    socket.close();
  });

  it('acknowledges Timeline subscription before live delivery and answers gap recovery requests', async () => {
    const { provider, relay, url } = await start();
    await relay.createAgent(createRequest('agent-live', 'provider-session-live'));
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-live/events`);

    const negotiated = collectMessages(socket, 2);
    socket.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    await negotiated;

    const subscribed = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.5.0', type: 'timeline_subscription',
      payload: { requestId: 'subscribe-1', agentIds: ['agent-live'] },
    }));
    expect(decodeServerMessage((await subscribed)[0] as string)).toMatchObject({
      status: 'ok', value: { type: 'timeline_subscribed', payload: { requestId: 'subscribe-1' } },
    });

    const live = collectMessages(socket, 1);
    provider.emit('provider-session-live', timelineObservation('live-1', 'Live output.', 2));
    expect(decodeServerMessage((await live)[0] as string)).toMatchObject({
      status: 'ok',
      value: {
        type: 'agent_stream',
        payload: {
          agentId: 'agent-live', epoch: 'epoch-http', seq: 1,
          event: { type: 'timeline', item: { type: 'assistant_message', text: 'Live output.' } },
        },
      },
    });

    const recovery = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.5.0', type: 'timeline_request',
      payload: {
        requestId: 'recover-1', agentId: 'agent-live', direction: 'after',
        cursor: { epoch: 'epoch-http', seq: 99 }, limit: 10,
      },
    }));
    expect(decodeServerMessage((await recovery)[0] as string)).toMatchObject({
      status: 'ok',
      value: { type: 'timeline_page', payload: { requestId: 'recover-1', gap: true, entries: [] } },
    });
    socket.close();
  });

  it('projects interaction state and dedicated notifications through the bound SessionWire', async () => {
    const { provider, relay, url } = await start();
    await relay.createAgent(createRequest('agent-interaction', 'provider-session-interaction'));
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-interaction/events`);
    const negotiated = collectMessages(socket, 2);
    socket.send(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate' }));
    await negotiated;

    const projected = collectMessages(socket, 2);
    provider.emit('provider-session-interaction', {
      type: 'observation', sourceKey: 'question-1', occurredAt: 3, delivery: 'live',
      event: {
        type: 'interaction_requested', provider: 'fake',
        request: {
          kind: 'question', requestId: 'question-1',
          questions: [{
            questionId: 'channel', header: 'Channel', prompt: 'Choose.', required: true,
            selection: 'single', options: [{ value: 'stable', label: 'Stable' }],
            allowCustomText: false, allowDismiss: false,
          }],
        },
      },
    });
    expect((await projected).map((json) => {
      const decoded = decodeServerMessage(json);
      return decoded.status === 'ok' ? decoded.value.type : 'rejected';
    })).toEqual(['agent_update', 'interaction_requested']);
    socket.close();
  });

  it('rejects malformed upgrades without breaking later HTTP or WebSocket traffic', async () => {
    const { relay, url } = await start();
    const port = Number(new URL(url).port);
    expect(await rawUpgrade(port, '/v1/sessions/%/events', 'dGhlIHNhbXBsZSBub25jZQ=='))
      .toMatch(/^HTTP\/1\.1 400 /);
    expect(await rawUpgrade(port, '/v1/sessions/agent/events', 'bad-key'))
      .toMatch(/^HTTP\/1\.1 400 /);

    await relay.createAgent(createRequest('agent-after-attack', 'provider-session-after-attack'));
    const snapshot = await fetch(
      `${url}/v1/sessions/agent-after-attack/snapshot?protocolVersion=1.5.0`,
    );
    expect(snapshot.status).toBe(200);
    const socket = await openSocket(`${url.replace('http:', 'ws:')}/v1/sessions/agent-after-attack/events`);
    socket.close();
  });
});

describe.each(interactionCases)('Serialized $kind interaction recovery', ({ request, response, invalid, malformed }) => {
  it('acknowledges one accepted client claim and keeps the request pending until normalized resolution', async () => {
    const context = await startInteraction(request);
    const first = await connectInteractionClient(context.url);
    const second = await connectInteractionClient(context.url);
    const submission = deferred();
    const submit = vi.spyOn(context.session, 'respondToInteraction').mockImplementation(() => submission.promise);
    const accepted = first.client.respondToInteraction(request.requestId, response);

    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await expect(second.client.respondToInteraction(request.requestId, response))
      .rejects.toMatchObject({ code: 'stale_interaction' });
    expect(first.observations.filter((event) => event.direction === 'outbound'
      && event.message.type === 'interaction_response')).toHaveLength(1);
    expect(submit).toHaveBeenCalledExactlyOnceWith(request.requestId, response);

    submission.resolve();
    await expect(accepted).resolves.toMatchObject({ payload: { command: 'interaction_response' } });
    expect((await first.transport.fetchSnapshot('agent-interaction')).payload.pendingInteractions).toEqual([request]);
    context.resolve(response);
    await vi.waitFor(() => expectCompleted(second.replica, request, response));
    expectCompleted(first.replica, request, response);
    await expect(second.client.respondToInteraction(request.requestId, response))
      .rejects.toMatchObject({ code: 'stale_interaction' });
    expect(submit).toHaveBeenCalledOnce();
  });

  it('rejects stale, mismatched, semantically invalid, and malformed responses before Provider submission', async () => {
    const context = await startInteraction(request);
    const connected = await connectInteractionClient(context.url);
    const submit = vi.spyOn(context.session, 'respondToInteraction');
    await expect(connected.client.respondToInteraction('unknown-request', response))
      .rejects.toMatchObject({ code: 'stale_interaction', requestId: 'unknown-request' });
    await expect(connected.client.respondToInteraction(request.requestId, invalid))
      .rejects.toMatchObject({ code: 'invalid_interaction_response' });
    const mismatched: AgentInteractionResponse = request.kind === 'question'
      ? { kind: 'plan_approval', action: 'reject' }
      : { kind: 'question', answers: [] };
    await expect(connected.client.respondToInteraction(request.requestId, mismatched))
      .rejects.toMatchObject({ code: 'invalid_interaction_response' });

    connected.socket().send(JSON.stringify({
      protocolVersion: '1.5.0', type: 'interaction_response',
      payload: { agentId: 'agent-interaction', requestId: request.requestId, submissionId: 'malformed-submission', operationId: '00000000-0000-4000-8000-000000000002', response: malformed },
    }));
    await vi.waitFor(() => expect(connected.observations).toContainEqual(expect.objectContaining({
      direction: 'inbound', channel: 'websocket',
      message: expect.objectContaining({
        type: 'protocol_error', payload: expect.objectContaining({ code: 'invalid_shape' }),
      }),
    })));
    expect(submit).not.toHaveBeenCalled();
    expect(connected.replica.getState().pendingInteractions).toEqual([request]);
    expect(connected.replica.getState().timeline.entries).toEqual([]);

    const accepted = connected.client.respondToInteraction(request.requestId, response);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(request.requestId, response));
    context.resolve(response);
    await accepted;
    await vi.waitFor(() => expectCompleted(connected.replica, request, response));
  });

  it('releases the claim after a definite Provider rejection so another client can retry', async () => {
    const context = await startInteraction(request);
    const first = await connectInteractionClient(context.url);
    const second = await connectInteractionClient(context.url);
    const submit = vi.spyOn(context.session, 'respondToInteraction')
      .mockRejectedValueOnce(new Error('Submission rejected before acceptance.'));

    await expect(first.client.respondToInteraction(request.requestId, response))
      .rejects.toMatchObject({ code: 'command_failed' });
    expect(first.replica.getState().pendingInteractions).toEqual([request]);
    expect(first.replica.getState().timeline.entries).toEqual([]);
    const retried = second.client.respondToInteraction(request.requestId, response);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]);
    context.resolve(response);
    await retried;
    await vi.waitFor(() => expectCompleted(first.replica, request, response));
    expectCompleted(second.replica, request, response);
  });

  it('recovers an accepted in-flight response after disconnect without automatically resubmitting it', async () => {
    const context = await startInteraction(request);
    const connected = await connectInteractionClient(context.url);
    const submission = deferred();
    const original = context.session.respondToInteraction.bind(context.session);
    const submit = vi.spyOn(context.session, 'respondToInteraction').mockImplementation(async (id, value) => {
      await submission.promise;
      await original(id, value);
    });
    const pending = connected.client.respondToInteraction(request.requestId, response);
    const disconnected = expect(pending).rejects.toMatchObject({ code: 'connection_disconnected' });
    await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
    connected.socket().terminate();
    await disconnected;

    submission.resolve();
    await vi.waitFor(() => expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]));
    context.resolve(response);
    await vi.waitFor(async () => {
      expect((await connected.transport.fetchSnapshot('agent-interaction')).payload.pendingInteractions).toEqual([]);
    });
    await connected.reconnect();
    await connected.ready();
    expectCompleted(connected.replica, request, response);

    const fresh = await connectInteractionClient(context.url);
    expectCompleted(fresh.replica, request, response);
    expect(submit).toHaveBeenCalledOnce();
    expect(connected.observations.filter((event) => event.direction === 'outbound'
      && event.message.type === 'interaction_response')).toHaveLength(1);
  });

  it('keeps resolved interactions completed across delayed HTTP Snapshot, history, and reconnect', async () => {
    const context = await startInteraction(request);
    const responder = await connectInteractionClient(context.url);
    const historyCaptured = deferred();
    const historyReleased = deferred();
    const snapshotCaptured = deferred();
    const snapshotReleased = deferred();
    closeables.push(async () => { historyReleased.resolve(); snapshotReleased.resolve(); });
    let heldHistory = false;
    const delayedFetch: typeof fetch = async (input, init) => {
      const reply = await fetch(input, init);
      const body = await reply.text();
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/timeline') && !heldHistory) {
        heldHistory = true;
        historyCaptured.resolve();
        await historyReleased.promise;
      } else if (path.endsWith('/snapshot')) {
        snapshotCaptured.resolve();
        await snapshotReleased.promise;
      }
      return new Response(body, { status: reply.status, headers: reply.headers });
    };
    const recovering = await connectInteractionClient(context.url, delayedFetch, false);
    await historyCaptured.promise;
    const interactionBaseline = recovering.replica.getState().interactionRevision;
    const delayedSnapshot = recovering.transport.fetchSnapshot('agent-interaction');
    await snapshotCaptured.promise;

    const accepted = responder.client.respondToInteraction(request.requestId, response);
    await vi.waitFor(() => expect(context.session.interactionResponses).toHaveLength(1));
    context.resolve(response);
    await accepted;
    await vi.waitFor(() => expect(recovering.replica.getState().pendingInteractions).toEqual([]));
    expect(recovering.replica.getState().timeline.initialized).toBe(false);
    expect(recovering.replica.getState().timeline.pendingLive).toHaveLength(1);
    historyReleased.resolve();
    await recovering.ready();
    expectCompleted(recovering.replica, request, response);

    snapshotReleased.resolve();
    const stale = await delayedSnapshot;
    expect(stale.payload.pendingInteractions).toEqual([request]);
    recovering.replica.applySnapshot(stale, { interactionBaseline });
    expectCompleted(recovering.replica, request, response);
    const overlappingHistory = await recovering.transport.fetchTimeline('agent-interaction', 'tail');
    recovering.replica.applyHistory(overlappingHistory);
    expectCompleted(recovering.replica, request, response);

    recovering.socket().terminate();
    await recovering.reconnect();
    await recovering.ready();
    expectCompleted(recovering.replica, request, response);
  });
});

describe('Serialized sensitive interaction recovery', () => {
  it('delivers a secret only to the provider and preserves redacted receipts through HTTP and reconnect', async () => {
    const request: AgentInteractionRequest = { kind: 'form', requestId: 'secret-form', title: 'Login', message: '', fields: [{ type: 'text', fieldId: 'token', label: 'Token', required: true, sensitive: true }] };
    const response: AgentInteractionResponse = { kind: 'form', action: 'submit', values: { token: 'transport-private-token' } };
    const redacted: AgentInteractionResponse = { kind: 'form', action: 'submit', values: {}, redactedFields: ['token'] };
    const context = await startInteraction(request);
    const connected = await connectInteractionClient(context.url);
    const accepted = connected.client.respondToInteraction(request.requestId, response);
    await vi.waitFor(() => expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]));
    await expect(accepted).resolves.toMatchObject({ payload: { command: 'interaction_response' } });
    context.resolve(response);
    await vi.waitFor(() => expectCompleted(connected.replica, request, redacted));
    const history = await connected.transport.fetchTimeline('agent-interaction', 'tail');
    expect(JSON.stringify(history)).not.toContain('transport-private-token');
    const incoming = connected.observations.filter(({ direction }) => direction === 'inbound');
    expect(JSON.stringify(incoming)).not.toContain('transport-private-token');
    connected.socket().terminate();
    await connected.reconnect();
    await connected.ready();
    expectCompleted(connected.replica, request, redacted);
  });
});

async function startInteraction(request: AgentInteractionRequest) {
  const context = await start([{
    type: 'observation', sourceKey: 'request-one', occurredAt: 1, delivery: 'history',
    event: { type: 'interaction_requested', provider: 'fake', request },
  }]);
  await new HttpWebSocketTransport(context.url).createAgent('agent-interaction', 'fake', { sessionId: 'session-interaction' });
  return {
    ...context,
    session: context.provider.requireSession('session-interaction'),
    resolve(response: AgentInteractionResponse) {
      context.provider.emit('session-interaction', {
        type: 'observation', sourceKey: 'resolved-one', occurredAt: 2, delivery: 'live',
        event: { type: 'interaction_resolved', provider: 'fake', requestId: request.requestId, response },
      });
    },
  };
}

async function connectInteractionClient(url: string, fetchImplementation?: typeof fetch, waitForReady = true) {
  const sockets: WebSocket[] = [];
  const observations: RemoteProtocolObservation[] = [];
  let status: RemoteSessionStatus = 'idle';
  let reconnect: (() => void) | undefined;
  const transport = new HttpWebSocketTransport(url, {
    fetch: fetchImplementation,
    webSocketFactory: (socketUrl) => {
      const socket = new WebSocket(socketUrl);
      sockets.push(socket);
      return socket as unknown as WebSocketLike;
    },
  });
  transport.onProtocolMessage((observation) => observations.push(observation));
  const replica = new AgentReplica();
  const client = new RemoteSessionClient('agent-interaction', transport, replica, {
    operationTimeoutMs: 5_000,
    scheduleReconnect: (_delay, restart) => {
      reconnect = restart;
      return () => { reconnect = undefined; };
    },
  });
  client.subscribeStatus((next) => { status = next; });
  closeables.push(async () => { client.stop(); });
  client.start();
  const ready = () => vi.waitFor(() => expect(status).toBe('ready'));
  if (waitForReady) await ready();
  return {
    client, transport, replica, observations, ready,
    socket: () => sockets.at(-1)!,
    reconnect: async () => {
      await vi.waitFor(() => expect(reconnect).toBeTypeOf('function'));
      reconnect!();
    },
  };
}

function expectCompleted(replica: AgentReplica, request: AgentInteractionRequest, response: AgentInteractionResponse): void {
  expect(replica.getState().pendingInteractions).toEqual([]);
  expect(replica.getState().timeline.entries.map((entry) => entry.item)).toEqual([{ type: 'interaction', request, response }]);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function createRequest(agentId: string, sessionId: string) {
  return {
    protocolVersion: '1.5.0' as const,
    type: 'create_agent' as const,
    payload: { requestId: `create-${agentId}`, operationId: '00000000-0000-4000-8000-000000000003', agentId, providerId: 'fake', config: { sessionId } },
  };
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

function collectMessages(socket: WebSocket, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const onMessage = (data: RawData): void => {
      messages.push(data.toString());
      if (messages.length !== count) return;
      cleanup();
      resolve(messages);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`WebSocket closed after ${messages.length} of ${count} expected messages.`));
    };
    const cleanup = (): void => {
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('message', onMessage);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function rawUpgrade(port: number, path: string, key: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let response = '';
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        'Host: 127.0.0.1',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${key}`,
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (response.length > 0) finish();
      else reject(error);
    });
  });
}

async function start(
  history: readonly ProviderStreamItem[] = [],
  authorizer: AgentRemoteWebSocketAuthorizer | null = {
    authenticate: () => ({ subject: 'local-test' }),
    authorize: () => true,
  },
): Promise<{
  provider: TestProvider;
  relay: AgentRemoteRelay;
  server: AgentRemoteHttpServer;
  url: string;
}> {
  const provider = new TestProvider(history);
  const relay = createAgentRemoteRelay({ providers: [provider], epoch: () => 'epoch-http' });
  const server = authorizer === null
    ? createAgentRemoteHttpServer(relay)
    : createAgentRemoteHttpServer(relay, { websocketAuthorizer: authorizer });
  const address = await server.listen(0, '127.0.0.1');
  closeables.push(async () => {
    await server.close();
    await relay.close();
  });
  return { provider, relay, server, url: address.url };
}

function timelineObservation(
  sourceKey: string,
  text: string,
  occurredAt: number,
  delivery: 'history' | 'live' = 'live',
): ProviderStreamItem {
  return {
    type: 'observation', sourceKey, occurredAt, delivery,
    event: {
      type: 'timeline', provider: 'fake', turnId: 'turn-1',
      item: { type: 'assistant_message', messageId: 'message-1', text },
    },
  };
}

class TestProvider implements AgentProviderAdapter {
  readonly descriptor = { providerId: 'fake', displayName: 'Fake Agent' };
  private readonly sessions = new Map<string, TestSession>();

  constructor(private readonly history: readonly ProviderStreamItem[]) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return this.createOwnedSession(config.sessionId, config.cwd);
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    return this.createOwnedSession(handle.sessionId);
  }

  emit(sessionId: string, item: ProviderStreamItem): void {
    this.requireSession(sessionId).stream.push(item);
  }

  requireSession(sessionId: string): TestSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown test session: ${sessionId}`);
    return session;
  }

  private createOwnedSession(sessionId: string, cwd?: string): TestSession {
    const session = new TestSession(sessionId, cwd);
    for (const item of this.history) session.stream.push(structuredClone(item));
    session.stream.push({ type: 'history_boundary' });
    this.sessions.set(sessionId, session);
    return session;
  }
}

class TestSession implements AgentSession {
  readonly capabilities = capabilities;
  readonly stream = new ManualProviderStream();
  readonly interactionResponses: Array<{ requestId: string; response: AgentInteractionResponse }> = [];

  constructor(private readonly sessionId: string, private readonly cwd?: string) {}

  observe(): AsyncIterable<ProviderStreamItem> { return this.stream; }
  async sendMessage(): Promise<void> {}
  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    this.interactionResponses.push({ requestId, response });
  }
  async runtimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      providerId: 'fake', sessionId: this.sessionId, status: 'idle',
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      persistence: { providerId: 'fake', sessionId: this.sessionId, opaque: `fake:${this.sessionId}` },
    };
  }
  async dispose(): Promise<void> { this.stream.finish(); }
}

class ManualProviderStream implements AsyncIterable<ProviderStreamItem> {
  private readonly values: ProviderStreamItem[] = [];
  private readonly waiters: Array<(result: IteratorResult<ProviderStreamItem>) => void> = [];
  private finished = false;

  push(value: ProviderStreamItem): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  finish(): void {
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<ProviderStreamItem> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { done: false, value };
        if (this.finished) return { done: true, value: undefined };
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
