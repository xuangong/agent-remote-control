import { describe, expect, it, vi } from 'vitest';

import {
  decodeAgentSessionResponse, decodeAgentSnapshot, decodeHistoryPage, decodeProviderListResponse, decodeServerMessage,
  encodeCreateAgentRequest, encodeResumeAgentRequest,
} from '@orchardworks/agent-remote-protocol';
import { AgentOperationRejectedError } from '@orchardworks/agent-provider-sdk';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-provider-sdk';
import type { AgentRemoteWebSocketAuthorizer } from '@orchardworks/agent-session-runtime';

import {
  closeables, collectMessages, connectInteractionClient, createRequest, deferred, expectCompleted, interactionCases, openSocket,
  recoversInFlightResponse, relayFetch, start, startInteraction, timelineObservation, waitFor,
} from './runtime-http-server.fixture.js';

/**
 * The Runtime HTTP server's contract over HTTP and the session WebSocket, reached in memory: the server parses real HTTP and frames
 * real WebSocket messages, with no port. What the socket itself does (binding, a malformed upgrade on a raw connection, a lost
 * connection) is in `tests/transport/runtime-http-server.transport.test.ts`.
 */
describe('Agent Remote HTTP transport', () => {
  it('serves the strict protocol Provider list response without native extension metadata', async () => {
    const { url, provider } = await start();
    Object.assign(provider.descriptor, { sessionExtensions: { instructions: true, tools: true } });
    const response = await relayFetch(`${url}/v1/providers?protocolVersion=1.8.0`, { signal: AbortSignal.timeout(5000) });
    const json = await response.text();

    expect(response.status).toBe(200);
    expect(decodeProviderListResponse(json)).toEqual({
      status: 'ok',
      value: {
        protocolVersion: '1.8.0',
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

  it('resumes an Agent and fetches Timeline pages independently of Snapshot', async () => {
    const history = [timelineObservation('history-1', 'Recovered output.', 1, 'history')];
    const { url } = await start(history);
    const body = encodeResumeAgentRequest({
      protocolVersion: '1.8.0', type: 'resume_agent',
      payload: {
        requestId: 'resume-1', agentId: 'agent-resumed',
        persistence: { providerId: 'fake', sessionId: 'provider-session-resumed', opaque: 'resume-token' },
      },
    });
    if (body.status !== 'ok') throw new Error('Resume fixture did not encode.');

    const resumeResponse = await relayFetch(`${url}/v1/sessions/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body.json,
    });
    const resumeJson = await resumeResponse.text();
    const timelineResponse = await relayFetch(
      `${url}/v1/sessions/agent-resumed/timeline?protocolVersion=1.8.0&requestId=tail-1&direction=tail&limit=10`,
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

    const snapshotResponse = await relayFetch(`${url}/v1/sessions/missing/snapshot?protocolVersion=1.0.1`);
    const createResponse = await relayFetch(`${url}/v1/sessions`, {
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
    const escaped = await relayFetch(`${url}/v1/sessions/%/snapshot?protocolVersion=1.8.0`);
    const oversized = await relayFetch(`${url}/v1/sessions`, {
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
    const negotiated = collectMessages(socket, 3);
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiate' }));
    await negotiated;

    const rejected = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.8.0', type: 'resource_request',
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
      protocolVersion: '1.8.0', type: 'timeline_subscription',
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
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiate' }));
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

    const negotiated = collectMessages(socket, 3);
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiate' }));
    await negotiated;

    const subscribed = collectMessages(socket, 1);
    socket.send(JSON.stringify({
      protocolVersion: '1.8.0', type: 'timeline_subscription',
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
      protocolVersion: '1.8.0', type: 'timeline_request',
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
    const negotiated = collectMessages(socket, 3);
    socket.send(JSON.stringify({ protocolVersion: '1.8.0', type: 'negotiate' }));
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

});

describe.each(interactionCases)('Serialized $kind interaction recovery', ({ request, response, invalid, malformed }) => {
  it('acknowledges one accepted client claim and keeps the request pending until normalized resolution', async () => {
    const context = await startInteraction(request);
    const first = await connectInteractionClient(context.url);
    const second = await connectInteractionClient(context.url);
    const submission = deferred();
    const submit = vi.spyOn(context.session, 'respondToInteraction').mockImplementation(() => submission.promise);
    const accepted = first.client.respondToInteraction(request.requestId, response);

    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    await second.client.takeControl();
    await expect(second.client.respondToInteraction(request.requestId, response))
      .rejects.toMatchObject({ code: 'stale_interaction' });
    expect(first.observations.filter((event) => event.direction === 'outbound'
      && event.message.type === 'interaction_response')).toHaveLength(1);
    expect(submit).toHaveBeenCalledExactlyOnceWith(request.requestId, response);

    submission.resolve();
    await expect(accepted).resolves.toMatchObject({ payload: { command: 'interaction_response' } });
    expect((await first.transport.fetchSnapshot('agent-interaction')).payload.pendingInteractions).toEqual([request]);
    context.resolve(response);
    await waitFor(() => expectCompleted(second.replica, request, response));
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
      protocolVersion: '1.8.0', type: 'interaction_response',
      payload: { agentId: 'agent-interaction', requestId: request.requestId, submissionId: 'malformed-submission', operationId: '00000000-0000-4000-8000-000000000002', response: malformed },
    }));
    await waitFor(() => expect(connected.observations).toContainEqual(expect.objectContaining({
      direction: 'inbound', channel: 'websocket',
      message: expect.objectContaining({
        type: 'protocol_error', payload: expect.objectContaining({ code: 'invalid_shape' }),
      }),
    })));
    expect(submit).not.toHaveBeenCalled();
    expect(connected.replica.getState().pendingInteractions).toEqual([request]);
    expect(connected.replica.getState().timeline.entries).toEqual([]);

    const accepted = connected.client.respondToInteraction(request.requestId, response);
    await waitFor(() => expect(submit).toHaveBeenCalledExactlyOnceWith(request.requestId, response));
    context.resolve(response);
    await accepted;
    await waitFor(() => expectCompleted(connected.replica, request, response));
  });

  it('releases the claim after a definite Provider rejection so another client can retry', async () => {
    const context = await startInteraction(request);
    const first = await connectInteractionClient(context.url);
    const second = await connectInteractionClient(context.url);
    const submit = vi.spyOn(context.session, 'respondToInteraction')
      .mockRejectedValueOnce(new AgentOperationRejectedError('native_rejected', 'Submission rejected before acceptance.'));

    await expect(first.client.respondToInteraction(request.requestId, response))
      .rejects.toMatchObject({ code: 'native_rejected' });
    expect(first.replica.getState().pendingInteractions).toEqual([request]);
    expect(first.replica.getState().timeline.entries).toEqual([]);
    await second.client.takeControl();
    const retried = second.client.respondToInteraction(request.requestId, response);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]);
    context.resolve(response);
    await retried;
    await waitFor(() => expectCompleted(first.replica, request, response));
    expectCompleted(second.replica, request, response);
  });

  it('recovers an accepted in-flight response after disconnect without automatically resubmitting it', () => recoversInFlightResponse(request, response));

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
      const reply = await relayFetch(input, init);
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
    await waitFor(() => expect(context.session.interactionResponses).toHaveLength(1));
    context.resolve(response);
    await accepted;
    await waitFor(() => expect(recovering.replica.getState().pendingInteractions).toEqual([]));
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
    await waitFor(() => expect(context.session.interactionResponses).toEqual([{ requestId: request.requestId, response }]));
    await expect(accepted).resolves.toMatchObject({ payload: { command: 'interaction_response' } });
    context.resolve(response);
    await waitFor(() => expectCompleted(connected.replica, request, redacted));
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
