import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';

import {
  AgentInteractionRequest,
  AgentInteractionResponse,
  AgentSessionResponse,
  AgentSnapshot,
  AgentStreamMessage,
  BORGEE_AGENT_REMOTE_PROTOCOL_VERSION,
  CommandAcknowledgementMessage,
  CreateAgentRequest,
  HistoryPage,
  ProviderListResponse,
  ResourceResponse,
  ResourceUpdate,
  ResumeAgentRequest,
  decodeAgentSnapshot,
  decodeAgentStreamMessage,
  decodeClientMessage,
  decodeCommandAcknowledgementMessage,
  decodeCreateAgentRequest,
  decodeHistoryPage,
  decodeProviderListResponse,
  decodeResourceResponse,
  decodeResourceUpdate,
  decodeResumeAgentRequest,
  decodeServerMessage,
  encodeAgentSnapshot,
  encodeAgentSessionResponse,
  encodeAgentStreamMessage,
  encodeCommandAcknowledgementMessage,
  encodeCreateAgentRequest,
  encodeHistoryPage,
  encodeProviderListResponse,
  encodeResourceUpdate,
  encodeResumeAgentRequest,
} from './index.js';

const version = '1.5.0';

it.each([null, 'native-active-turn'])('round trips authoritative active turn %s on runtime updates', activeTurnId => {
  const message = { protocolVersion: version, type: 'agent_stream', payload: {
    agentId: 'agent-7', timestamp: '2026-09-18T00:00:00.000Z', event: {
      type: 'runtime_updated', providerId: 'codex', activeTurnId,
      runtimeInfo: { providerId: 'codex', sessionId: 'thread-7', status: activeTurnId ? 'running' : 'idle' },
    },
  } };
  expect(decodeAgentStreamMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
});

const questionRequest = {
  kind: 'question',
  requestId: 'question-request',
  questions: [{
    questionId: 'release-channel',
    header: 'Release channel',
    prompt: 'Where should this build be released?',
    description: 'Choose every acceptable channel.',
    required: true,
    selection: 'multiple',
    options: [
      { value: 'beta', label: 'Beta', description: 'Internal testers' },
      { value: 'stable', label: 'Stable', description: 'All users' },
    ],
    allowCustomText: true,
    allowDismiss: false,
  }],
} as const;

const snapshot = {
  protocolVersion: version,
  type: 'agent_snapshot',
  payload: {
    id: 'agent-7',
    providerId: 'codex',
    cwd: '/workspace',
    model: 'gpt-5.6-codex',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:01.000Z',
    status: 'waiting',
    activeTurn: null,
    capabilities: {
      history: true,
      sendMessage: true,
      steer: true,
      cancel: true,
      readResource: true,
      interactions: { question: true, planApproval: true, toolApproval: true },
    },
    pendingInteractions: [questionRequest],
    runtimeInfo: {
      providerId: 'codex',
      sessionId: 'thread-7',
      status: 'waiting',
      cwd: '/workspace',
      model: 'gpt-5.6-codex',
    },
  },
} as const;

const timelinePage = {
  protocolVersion: version,
  type: 'timeline_page',
  payload: {
    requestId: 'timeline-request',
    agentId: 'agent-7',
    direction: 'tail',
    epoch: 'epoch-1',
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 2, nextSeq: 3 },
    startCursor: { epoch: 'epoch-1', seq: 0 },
    endCursor: { epoch: 'epoch-1', seq: 2 },
    hasOlder: false,
    hasNewer: false,
    entries: [{
      providerId: 'codex',
      item: { type: 'assistant_message', text: 'Generated [chart](workspace://chart.png).' },
      turnId: 'turn-1',
      timestamp: '2026-09-02T00:00:01.000Z',
      seqStart: 1,
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      collapsed: ['assistant_merge'],
      resources: [{ locator: 'workspace://chart.png', resourceId: 'sha256:abc', status: 'available' }],
    }],
    error: null,
  },
} as const;

describe('exact protocol version and Snapshot', () => {
  it('accepts only the one negotiated protocol version', () => {
    expect(BORGEE_AGENT_REMOTE_PROTOCOL_VERSION).toBe(version);
    expect(decodeAgentSnapshot(JSON.stringify(snapshot)).status).toBe('ok');
    expect(decodeAgentSnapshot(JSON.stringify({ ...snapshot, protocolVersion: '1.0.1' }))).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'incompatible_protocol_version', path: '/protocolVersion' }],
    });
  });

  it('keeps Timeline epoch, cursor, and rows out of Snapshot', () => {
    expect(Value.Check(AgentSnapshot, snapshot)).toBe(true);
    for (const forbidden of [
      { timeline: [] },
      { epoch: 'epoch-1' },
      { cursor: { epoch: 'epoch-1', seq: 2 } },
    ]) {
      expect(Value.Check(AgentSnapshot, { ...snapshot, payload: { ...snapshot.payload, ...forbidden } })).toBe(false);
    }
    expect(encodeAgentSnapshot(snapshot).status).toBe('ok');
  });
});

describe('strict interactions', () => {
  it('preserves planning controls and authoritative planning state', () => {
    const request = { protocolVersion: version, type: 'set_planning', payload: { requestId: 'planning-1', operationId: '00000000-0000-4000-8000-000000000001', agentId: 'agent-7', active: true } };
    expect(decodeClientMessage(JSON.stringify(request))).toEqual({ status: 'ok', value: request });
    expect(decodeClientMessage(JSON.stringify({ ...request, payload: { ...request.payload, active: 'plan' } })).status).toBe('rejected');
    const planned = { ...snapshot, payload: { ...snapshot.payload,
      capabilities: { ...snapshot.payload.capabilities, planning: true },
      runtimeInfo: { ...snapshot.payload.runtimeInfo, planning: { active: false, requested: true } },
    } };
    expect(decodeAgentSnapshot(JSON.stringify(planned))).toEqual({ status: 'ok', value: planned });
  });

  it('preserves plan revision feedback only on a rejection', () => {
    expect(Value.Check(AgentInteractionResponse, { kind: 'plan_approval', action: 'reject', feedback: 'Keep the existing API.' })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'plan_approval', action: 'approve', feedback: 'Change it.' })).toBe(false);
  });

  it('round trips completed interaction history through Timeline pages', () => {
    const item = { type: 'interaction', request: questionRequest, response: { kind: 'question', answers: [{ questionId: 'release-channel', selectedValues: ['beta'] }] } };
    const history = { ...timelinePage, payload: { ...timelinePage.payload, entries: [{ ...timelinePage.payload.entries[0], item }] } };
    expect(decodeHistoryPage(JSON.stringify(history))).toEqual({ status: 'ok', value: history });
  });

  it('preserves Codex questions and question-id keyed answers without generic permission metadata', () => {
    const response = {
      kind: 'question',
      answers: [{ questionId: 'release-channel', selectedValues: ['beta'], customText: 'canary' }],
    } as const;

    expect(Value.Check(AgentInteractionRequest, questionRequest)).toBe(true);
    expect(Value.Check(AgentInteractionResponse, response)).toBe(true);
    expect(Value.Check(AgentInteractionRequest, { ...questionRequest, metadata: { native: true } })).toBe(false);
    expect(Value.Check(AgentInteractionResponse, {
      kind: 'question', answers: [{ questionId: 'release-channel', answer: 'beta' }],
    })).toBe(false);
  });

  it('uses closed plan and tool approval request and response unions', () => {
    const plan = {
      kind: 'plan_approval', requestId: 'plan-request', plan: '## Plan',
      allowedActions: ['approve', 'approve_and_resume', 'reject'],
    } as const;
    const tool = {
      kind: 'tool_approval', requestId: 'tool-request', toolCallId: 'call-7', toolName: 'shell',
      summary: 'Run tests.', detail: { type: 'shell', command: 'pnpm test', cwd: '/workspace' },
      allowedDecisions: ['allow', 'deny'], allowScopes: ['once', 'session'],
    } as const;

    expect(Value.Check(AgentInteractionRequest, plan)).toBe(true);
    expect(Value.Check(AgentInteractionRequest, tool)).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'plan_approval', action: 'approve' })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'tool_approval', decision: 'allow', scope: 'session' })).toBe(true);
    expect(Value.Check(AgentInteractionResponse, { kind: 'tool_approval', decision: 'deny', scope: 'session' })).toBe(false);
    expect(Value.Check(AgentInteractionResponse, { kind: 'plan_approval', action: 'later' })).toBe(false);
  });
});

describe('projected Timeline and public live stream', () => {
  it('rejects a zero Timeline request limit as an invalid protocol shape', () => {
    const request = {
      protocolVersion: version,
      type: 'timeline_request',
      payload: {
        requestId: 'timeline-zero-limit',
        agentId: 'agent-7',
        direction: 'tail',
        limit: 0,
      },
    } as const;

    expect(decodeClientMessage(JSON.stringify(request))).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'invalid_shape' }],
    });
  });

  it('rejects an unsafe Timeline request limit as an invalid protocol shape', () => {
    const request = {
      protocolVersion: version,
      type: 'timeline_request',
      payload: {
        requestId: 'timeline-unsafe-limit',
        agentId: 'agent-7',
        direction: 'tail',
        limit: Number.MAX_SAFE_INTEGER + 1,
      },
    } as const;

    expect(decodeClientMessage(JSON.stringify(request))).toMatchObject({
      status: 'rejected',
      issues: [{ code: 'invalid_shape' }],
    });
  });

  it('round trips projected pages with sequence coverage and resource bindings', () => {
    expect(Value.Check(HistoryPage, timelinePage)).toBe(true);
    const encoded = encodeHistoryPage(timelinePage);
    expect(encoded.status).toBe('ok');
    if (encoded.status !== 'ok') return;
    expect(decodeHistoryPage(encoded.json)).toEqual({ status: 'ok', value: timelinePage });
  });

  it('declares public agent_stream separately and requires position for Timeline events', () => {
    const message = {
      protocolVersion: version,
      type: 'agent_stream',
      payload: {
        agentId: 'agent-7',
        timestamp: '2026-09-02T00:00:01.000Z',
        epoch: 'epoch-1',
        seq: 3,
        event: {
          type: 'timeline',
          providerId: 'codex',
          item: { type: 'reasoning', text: 'Checking the result.' },
          turnId: 'turn-1',
          resources: [],
        },
      },
    } as const;

    expect(Value.Check(AgentStreamMessage, message)).toBe(true);
    expect(Value.Check(AgentStreamMessage, {
      ...message,
      payload: { agentId: 'agent-7', timestamp: message.payload.timestamp, event: message.payload.event },
    })).toBe(false);
    const encoded = encodeAgentStreamMessage(message);
    expect(encoded.status).toBe('ok');
    if (encoded.status !== 'ok') return;
    expect(decodeAgentStreamMessage(encoded.json)).toEqual({ status: 'ok', value: message });
  });

  it('keeps Provider read locators out of public Timeline resource bindings', () => {
    const message = {
      protocolVersion: version,
      type: 'agent_stream',
      payload: {
        agentId: 'agent-7',
        timestamp: '2026-09-02T00:00:01.000Z',
        epoch: 'epoch-1',
        seq: 3,
        event: {
          type: 'timeline',
          providerId: 'dsh',
          item: {
            type: 'tool_call',
            callId: 'write-one',
            name: 'write',
            detail: { type: 'write', filePath: 'reports/result.txt' },
            status: 'completed',
            error: null,
          },
          resources: [{
            locator: 'reports/result.txt',
            readLocator: 'dsh-generated:opaque-revision',
            resourceId: 'resource-1',
            status: 'available',
          }],
        },
      },
    };

    expect(Value.Check(AgentStreamMessage, message)).toBe(false);
    expect(decodeAgentStreamMessage(JSON.stringify(message)).status).toBe('rejected');
  });
});

describe('resource and session messages', () => {
  it('round trips a strict exact-version Provider list response', () => {
    const response = {
      protocolVersion: version,
      type: 'provider_list',
      payload: {
        providers: [
          { providerId: 'codex', displayName: 'Codex' },
          { providerId: 'dsh', displayName: 'DeepSeek Harness' },
        ],
      },
    } as const;

    expect(Value.Check(ProviderListResponse, response)).toBe(true);
    const encoded = encodeProviderListResponse(response);
    expect(encoded.status).toBe('ok');
    if (encoded.status === 'ok') expect(decodeProviderListResponse(encoded.json)).toEqual({ status: 'ok', value: response });
    expect(decodeServerMessage(JSON.stringify(response)).status).toBe('ok');
    expect(Value.Check(ProviderListResponse, {
      ...response,
      payload: { providers: [{ providerId: 'codex', displayName: 'Codex', native: true }] },
    })).toBe(false);
    expect(decodeProviderListResponse(JSON.stringify({ ...response, protocolVersion: '1.0.1' }))).toMatchObject({
      status: 'rejected', issues: [{ code: 'incompatible_protocol_version', path: '/protocolVersion' }],
    });
  });

  it('round trips create and resume requests with provider configuration and persistence identity', () => {
    const create = {
      protocolVersion: version,
      type: 'create_agent',
      payload: {
        requestId: 'create-request',
        operationId: '00000000-0000-4000-8000-000000000002',
        agentId: 'agent-7',
        providerId: 'codex',
        config: {
          sessionId: 'thread-7',
          cwd: '/workspace',
          model: 'gpt-5.6-codex',
          reasoningEffort: 'high',
          systemPrompt: 'Keep answers concise.',
        },
      },
    } as const;
    const resume = {
      protocolVersion: version,
      type: 'resume_agent',
      payload: {
        requestId: 'resume-request',
        agentId: 'agent-7',
        persistence: { providerId: 'codex', sessionId: 'thread-7', opaque: 'resume-token' },
      },
    } as const;
    const response = {
      protocolVersion: version,
      type: 'agent_session',
      payload: {
        requestId: 'create-request',
        agentId: 'agent-7',
        providerId: 'codex',
        sessionId: 'thread-7',
        persistence: { providerId: 'codex', sessionId: 'thread-7', opaque: 'resume-token' },
      },
    } as const;

    expect(Value.Check(CreateAgentRequest, create)).toBe(true);
    expect(Value.Check(ResumeAgentRequest, resume)).toBe(true);
    expect(Value.Check(AgentSessionResponse, response)).toBe(true);
    expect(decodeClientMessage(JSON.stringify(create)).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify(resume)).status).toBe('ok');
    expect(decodeServerMessage(JSON.stringify(response)).status).toBe('ok');

    const encodedCreate = encodeCreateAgentRequest(create);
    expect(encodedCreate.status).toBe('ok');
    if (encodedCreate.status === 'ok') expect(decodeCreateAgentRequest(encodedCreate.json)).toEqual({ status: 'ok', value: create });
    const encodedResume = encodeResumeAgentRequest(resume);
    expect(encodedResume.status).toBe('ok');
    if (encodedResume.status === 'ok') expect(decodeResumeAgentRequest(encodedResume.json)).toEqual({ status: 'ok', value: resume });
    expect(encodeAgentSessionResponse(response).status).toBe('ok');

    expect(Value.Check(CreateAgentRequest, {
      ...create,
      payload: { ...create.payload, providerId: undefined },
    })).toBe(false);
    expect(Value.Check(ResumeAgentRequest, {
      ...resume,
      payload: { ...resume.payload, persistence: { providerId: 'codex', sessionId: 'thread-7' } },
    })).toBe(false);
  });

  it('acknowledges accepted message, steer, and cancel commands by request identity', () => {
    for (const command of ['send_message', 'steer', 'cancel'] as const) {
      const acknowledgement = {
        protocolVersion: version,
        type: 'command_acknowledged',
        payload: { requestId: `${command}-request`, agentId: 'agent-7', command },
      } as const;

      expect(Value.Check(CommandAcknowledgementMessage, acknowledgement)).toBe(true);
      expect(decodeServerMessage(JSON.stringify(acknowledgement)).status).toBe('ok');
      const encoded = encodeCommandAcknowledgementMessage(acknowledgement);
      expect(encoded.status).toBe('ok');
      if (encoded.status === 'ok') {
        expect(decodeCommandAcknowledgementMessage(encoded.json)).toEqual({ status: 'ok', value: acknowledgement });
      }
    }
    const missingRequestId = {
      protocolVersion: version,
      type: 'command_acknowledged',
      payload: { agentId: 'agent-7', command: 'send_message' },
    } as const;
    expect(Value.Check(CommandAcknowledgementMessage, missingRequestId)).toBe(false);
    expect(decodeCommandAcknowledgementMessage(JSON.stringify(missingRequestId)).status).toBe('rejected');
  });

  it.each([
    { status: 'pending', retryAfterMs: 500 },
    { status: 'available', mediaType: 'image/png', byteLength: 12, sha256: 'abc', contentBase64: 'aGVsbG8=' },
    { status: 'failed', message: 'Read failed.', retryable: true },
    { status: 'unavailable', reason: 'Provider stopped.' },
  ])('accepts the $status resource state', (state) => {
    const message = {
      protocolVersion: version,
      type: 'resource_response',
      payload: { requestId: 'resource-request', agentId: 'agent-7', resourceId: 'sha256:abc', state },
    };

    expect(Value.Check(ResourceResponse, message)).toBe(true);
    expect(decodeResourceResponse(JSON.stringify(message)).status).toBe('ok');
  });

  it('accepts image dimensions in metadata and rejects malformed sizes', () => {
    const state = { status: 'available', mediaType: 'image/png', byteLength: 300, sha256: 'digest', imageDimensions: { width: 800, height: 600 } };
    const message = { protocolVersion: version, type: 'resource_resolve_response', payload: {
      requestId: 'dimensions', agentId: 'agent-7', binding: { locator: './plot.png', resourceId: 'plot', status: 'available' }, state,
    } };
    expect(decodeServerMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
    for (const imageDimensions of [{ width: 0, height: 600 }, { width: -1, height: 600 }, { width: 1.5, height: 600 }, { width: 800 }, { width: 2 ** 32, height: 1 }]) {
      expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, state: { ...state, imageDimensions } } })).status).toBe('rejected');
    }
    expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, state: { ...state, contentBase64: 'AAAA' } } })).status).toBe('rejected');
  });

  it('validates resource resolution without accepting filesystem controls', () => {
    const request = {
      protocolVersion: version,
      type: 'resource_resolve_request',
      payload: {
        requestId: 'resolve-one', agentId: 'agent-7', locator: './images/result.png',
        sourceLocator: '/workspace/docs/report.md',
      },
    } as const;
    const response = {
      protocolVersion: version,
      type: 'resource_resolve_response',
      payload: {
        requestId: 'resolve-one', agentId: 'agent-7',
        binding: { locator: './images/result.png', resourceId: 'resource-one', status: 'available' },
      },
    } as const;

    expect(decodeClientMessage(JSON.stringify(request))).toEqual({ status: 'ok', value: request });
    expect(decodeServerMessage(JSON.stringify(response))).toEqual({ status: 'ok', value: response });
    expect(decodeClientMessage(JSON.stringify({
      ...request, payload: { ...request.payload, authorizedRoot: '/' },
    })).status).toBe('rejected');
  });

  it('round trips strict resource updates without a request identity', () => {
    const message = {
      protocolVersion: version,
      type: 'resource_update',
      payload: {
        agentId: 'agent-7',
        resourceId: 'resource-7',
        state: { status: 'failed', message: 'Read failed.', retryable: true },
      },
    } as const;

    expect(Value.Check(ResourceUpdate, message)).toBe(true);
    expect(decodeServerMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
    const encoded = encodeResourceUpdate(message);
    expect(encoded.status).toBe('ok');
    if (encoded.status === 'ok') expect(decodeResourceUpdate(encoded.json)).toEqual({ status: 'ok', value: message });
    expect(Value.Check(ResourceUpdate, {
      ...message,
      payload: { ...message.payload, requestId: 'resource-request' },
    })).toBe(false);
  });

  it('round trips a strict Timeline resource binding replacement at one canonical row', () => {
    const message = {
      protocolVersion: version,
      type: 'timeline_resource_binding_replaced',
      payload: {
        agentId: 'agent-7',
        epoch: 'epoch-1',
        seq: 4,
        previous: { locator: 'output.png', resourceId: 'resource-2', status: 'pending' },
        replacement: { locator: 'output.png', resourceId: 'resource-1', status: 'available' },
      },
    } as const;

    expect(decodeServerMessage(JSON.stringify(message))).toEqual({ status: 'ok', value: message });
    expect(decodeServerMessage(JSON.stringify({
      ...message,
      payload: { ...message.payload, seq: -1 },
    })).status).toBe('rejected');
    expect(decodeServerMessage(JSON.stringify({
      ...message,
      payload: { ...message.payload, previous: { ...message.payload.previous, native: true } },
    })).status).toBe('rejected');
  });

  it('keeps resource bytes behind resource responses while updates expose only lifecycle metadata', () => {
    const availableState = {
      status: 'available',
      mediaType: 'image/png',
      byteLength: 5,
      sha256: 'a'.repeat(64),
    } as const;
    const update = {
      protocolVersion: version,
      type: 'resource_update',
      payload: { agentId: 'agent-7', resourceId: 'resource-7', state: availableState },
    } as const;

    expect(Value.Check(ResourceUpdate, update)).toBe(true);
    expect(decodeServerMessage(JSON.stringify(update))).toEqual({ status: 'ok', value: update });
    expect(Value.Check(ResourceUpdate, {
      ...update,
      payload: { ...update.payload, state: { ...availableState, contentBase64: 'aGVsbG8=' } },
    })).toBe(false);
    expect(Value.Check(ResourceResponse, {
      protocolVersion: version,
      type: 'resource_response',
      payload: {
        requestId: 'resource-read', agentId: 'agent-7', resourceId: 'resource-7',
        state: availableState,
      },
    })).toBe(false);
  });

  it.each([
    'not base64!',
    'abc',
    'aGVsbG8',
    'aGVsbG8===',
    'aGV=bG8=',
  ])('rejects non-canonical Base64 content %j', (contentBase64) => {
    const message = {
      protocolVersion: version,
      type: 'resource_response',
      payload: {
        requestId: 'resource-request',
        agentId: 'agent-7',
        resourceId: 'resource-7',
        state: {
          status: 'available',
          mediaType: 'image/png',
          byteLength: 5,
          sha256: 'a'.repeat(64),
          contentBase64,
        },
      },
    };

    expect(Value.Check(ResourceResponse, message)).toBe(false);
    expect(decodeResourceResponse(JSON.stringify(message)).status).toBe('rejected');
  });

  it('validates interaction commands and notifications through closed client/server unions', () => {
    const response = {
      protocolVersion: version,
      type: 'interaction_response',
      payload: {
        agentId: 'agent-7', requestId: 'question-request', submissionId: 'question-submission', operationId: '00000000-0000-4000-8000-000000000003',
        response: { kind: 'question', answers: [{ questionId: 'release-channel', selectedValues: ['beta'] }] },
      },
    } as const;
    const notification = {
      protocolVersion: version,
      type: 'interaction_requested',
      payload: { agentId: 'agent-7', request: questionRequest },
    } as const;

    expect(decodeClientMessage(JSON.stringify(response)).status).toBe('ok');
    expect(decodeServerMessage(JSON.stringify(notification)).status).toBe('ok');
    expect(decodeClientMessage(JSON.stringify({
      ...response,
      payload: { ...response.payload, response: { kind: 'permission', decision: 'allow' } },
    })).status).toBe('rejected');
  });

  it('keeps interaction lifecycle out of the public agent_stream path', () => {
    const duplicatePath = {
      protocolVersion: version,
      type: 'agent_stream',
      payload: {
        agentId: 'agent-7',
        timestamp: '2026-09-02T00:00:01.000Z',
        event: { type: 'interaction_requested', providerId: 'codex', request: questionRequest },
      },
    } as const;

    expect(Value.Check(AgentStreamMessage, duplicatePath)).toBe(false);
    expect(decodeServerMessage(JSON.stringify(duplicatePath)).status).toBe('rejected');
  });
});

it('round-trips strict activity observation without accepting content fields', () => {
  expect(decodeClientMessage(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate', observation: 'activity' })).status).toBe('ok');
  const activity = { protocolVersion: '1.5.0', type: 'agent_activity', payload: { agentId: 'agent', status: 'waiting' } };
  expect(decodeServerMessage(JSON.stringify(activity))).toMatchObject({ status: 'ok', value: activity });
  expect(decodeServerMessage(JSON.stringify({ ...activity, payload: { ...activity.payload, text: 'private' } })).status).toBe('rejected');
});


it('round-trips an activity content cursor and rejects invalid cursor values', () => {
  expect(decodeClientMessage(JSON.stringify({ protocolVersion: '1.5.0', type: 'negotiate', observation: 'activity' })).status).toBe('ok');
  const message = { protocolVersion: '1.5.0', type: 'agent_activity', payload: {
    agentId: 'agent', status: 'waiting', cursor: { epoch: 'epoch', seq: 42 },
  } };
  expect(decodeServerMessage(JSON.stringify(message))).toMatchObject({ status: 'ok', value: message });
  for (const cursor of [{ epoch: '', seq: 42 }, { epoch: 'epoch', seq: -1 }, { epoch: 'epoch', seq: 1.5 }]) {
    expect(decodeServerMessage(JSON.stringify({ ...message, payload: { ...message.payload, cursor } })).status).toBe('rejected');
  }
});
