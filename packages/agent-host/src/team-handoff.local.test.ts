import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { ClaudeAgentProvider } from '@orchardworks/agent-provider-claude';
import { PROTOCOL_VERSION, type NativeSessionRef, type ServerMessage } from '@orchardworks/agent-remote-protocol';
import { createAgentRemoteHttpServer } from '@orchardworks/agent-remote-relay';
import { nativeFixture, nativeReply } from '../../agent-provider-claude/src/test-utils/native-fixture.js';
// The real catalog runs its worker process from the build output.
import { createClaudeCatalog } from '../../agent-provider-claude/dist/catalog.js';
import { TeamBroker } from '../../agent-remote-hosted/src/teams.js';
import type { SavedTeam } from '../../agent-remote-hosted/src/team-delivery.js';
import { createClaudeSessionDirectory } from './claude-directory.js';
import { createCodexHostRegistration } from './codex.js';
import { createAgentHostRuntime } from './host.js';
import { SessionReferenceStore } from './session-reference.js';

const claudeExecutable = process.env.AGENT_CLAUDE_TEST_EXECUTABLE, codexExecutable = process.env.ARC_CODEX_SUCCESSION_TEST_EXECUTABLE;

it.runIf(!!claudeExecutable && !!codexExecutable)('hands a Codex Team Leader off to Claude, which keeps its Team tools and the captured conversation', async () => {
  // Claude: the successor reads its Team, then answers.
  const claudeBodies: any[] = [];
  const f = await nativeFixture((body, response) => {
    claudeBodies.push(body);
    const readTeam = body.tools?.find((tool: { name: string }) => tool.name.endsWith('read_team'));
    const answered = JSON.stringify(body.messages).includes('tool_result');
    if (readTeam && !answered) nativeReply(response, [{ type: 'tool_use', id: 'team-call', name: readTeam.name, input: {} }]);
    else nativeReply(response, [{ type: 'text', text: 'SUCCESSOR_OK' }]);
  });
  // Codex: the Leader answers once before its handoff.
  const codexHome = join(f.home, 'codex'); await mkdir(codexHome);
  const codexServer = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      if (request.url !== '/v1/responses') { response.writeHead(404).end(); return; }
      response.setHeader('content-type', 'text/event-stream');
      response.end([{ type: 'response.created', response: { id: 'r' } },
        { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'leader-answer', content: [{ type: 'output_text', text: 'LEADER_BEFORE_HANDOFF' }] } },
        { type: 'response.completed', response: { id: 'r', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } },
      ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
    });
  });
  codexServer.listen(0, '127.0.0.1'); await once(codexServer, 'listening');
  await writeFile(join(codexHome, 'config.toml'), `model = "mock-model"\nmodel_provider = "mock"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[features]\nplugins = false\n`
    + `[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${(codexServer.address() as { port: number }).port}/v1"\nwire_api = "responses"\nenv_key = "OPENAI_API_KEY"\n`);
  const codex = await createCodexHostRegistration({ executable: codexExecutable, codexHome, env: { OPENAI_API_KEY: 'local-test', LC_ALL: 'C' }, referenceDirectory: join(f.home, 'codex-references') });
  const claude = new ClaudeAgentProvider({ ...f.options, catalog: createClaudeCatalog(f.options.env, 15000) });
  let teams: SavedTeam[] = [];
  let host!: ReturnType<typeof createAgentHostRuntime>;
  const broker = new TeamBroker({ read: () => teams, now: Date.now, assertHost() {},
    resolveSession: (_host, providerId, nativeSessionId) => host.roleRouting!.resolve({ controllerId: 'host', providerId, nativeSessionId }).target,
    async change(update) { const draft = structuredClone(teams), value = structuredClone(update(draft)); teams = draft; return value; },
    async createSeat(_host, seat) {
      const result = await host.control({ method: 'POST', path: '/remote/team/create-seat', body: JSON.stringify(seat) });
      if (result.status !== 200) throw new Error(result.body); return JSON.parse(result.body);
    },
  });
  host = createAgentHostRuntime({ succession: { controllerId: 'host', stateDirectory: join(f.home, 'succession'), enrollment: true },
    team: { stateDirectory: join(f.home, 'team'), tickMs: 100, request: call => broker.hostCall('host', call, () => {}, true), genericSuccession: () => true },
    registrations: [codex, { directory: createClaudeSessionDirectory(claude, [], undefined, new SessionReferenceStore(join(f.home, 'claude-references'), 'claude')), adapter: claude }] });
  const authority = { version: 1 as const, origin: 'https://relay.invalid', issuer: 'issuer', namespace: 'tenant', ownerSubject: 'owner' };
  const enroll = async (input: unknown) => {
    const result = await host.enrollFromRelay({ method: 'POST', path: '/remote/succession/enrollment', body: JSON.stringify(input) }, { authority, installationId: 'host', successionEnrollmentVersion: 3 });
    return { status: result.status, data: JSON.parse(result.body) };
  };
  const control = async (path: string, body: unknown) => {
    const result = await host.control({ method: 'POST', path, sessionId: randomUUID(), body: JSON.stringify(body) });
    if (result.status >= 300) throw new Error(result.body); return JSON.parse(result.body);
  };
  // Input goes through the Session protocol, as from the website, so a successor's first input carries its context.
  const wire = createAgentRemoteHttpServer(host.relay, { websocketAuthorizer: { authenticate: () => ({ subject: 'owner' }), authorize: () => true } });
  const { url } = await wire.listen(0);
  const turn = async (agentId: string, text: string) => {
    const agent = host.relay.requireAgent(agentId);
    let ended = 0; const stop = agent.subscribe(update => { if (update.type === 'agent_stream' && ['turn_completed', 'turn_failed'].includes(update.event.type)) ended++; });
    const socket = new WebSocket(`${url.replace('http', 'ws')}/v1/sessions/${agentId}/events`), messages: ServerMessage[] = [];
    let token: string | undefined;
    socket.on('message', data => {
      const message: ServerMessage = JSON.parse(data.toString()); messages.push(message);
      // Claude asks before running a Host tool, as it does for any member; the user allows it once.
      if (message.type === 'interaction_requested' && token) {
        socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'interaction_response', controlToken: token, payload: { agentId, requestId: message.payload.request.requestId,
          submissionId: randomUUID(), operationId: randomUUID(), response: { kind: 'tool_approval', decision: 'allow', scope: 'once' } } }));
      }
    });
    const next = (matches: (message: ServerMessage) => boolean) => expect.poll(() => messages.find(matches), { timeout: 10000 }).toBeTruthy().then(() => messages.find(matches)!);
    try {
      await once(socket, 'open');
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'negotiate' }));
      const state = await next(message => message.type === 'session_control');
      if (state.type !== 'session_control') throw new Error('Missing control state');
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_control_request', payload: { agentId, requestId: 'control', action: 'take_over', revision: state.payload.revision } }));
      const granted = await next(message => message.type === 'session_control' && message.payload.requestId === 'control');
      if (granted.type !== 'session_control') throw new Error('Missing control grant');
      token = granted.payload.token;
      const operationId = randomUUID();
      socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'send_message', controlToken: granted.payload.token, payload: { requestId: operationId, operationId, agentId, text } }));
      const sent = await next(message => (message.type === 'protocol_error' || message.type === 'command_acknowledged') && message.payload.requestId === operationId);
      expect(sent.type, JSON.stringify(sent)).toBe('command_acknowledged');
      await expect.poll(() => ended, { timeout: 30000 }).toBe(1).catch(error => { throw new Error(`${text}: ${JSON.stringify(messages.map(message => message.type === 'agent_stream' ? message.payload.event.type : message.type))}`, { cause: error }); });
    } finally { stop(); socket.terminate(); }
  };
  try {
    const source = await control('/remote/create', { providerId: 'codex', operationId: randomUUID(), cwd: f.cwd });
    const team = await broker.create({ operationId: randomUUID(), source: { hostId: 'host', providerId: 'codex', nativeSessionId: source.nativeSessionId, title: 'Source' } });
    const leader = team.members[0]!;
    expect(leader).toMatchObject({ creation: 'ready', providerId: 'codex' });
    const attached = await control('/remote/attach', { providerId: 'codex', nativeSessionId: leader.nativeSessionId });
    await turn(attached.agentId, 'LEADER_FIRST_PROMPT');

    const from: NativeSessionRef = { controllerId: 'host', providerId: 'codex', nativeSessionId: leader.nativeSessionId! };
    const described = await enroll({ action: 'describe', providerId: 'codex', nativeSessionId: from.nativeSessionId });
    expect(described.data.eligibility, JSON.stringify(described.data)).toEqual({ status: 'ready' });
    expect(described.data.targets.map((target: { providerId: string }) => target.providerId)).toContain('claude');
    const freeze = { version: 2, token: 'freeze', authority, controllerId: 'host', maxProjectionBytes: 2 * 1024 * 1024, associationRevision: 0, lineage: [from], relations: [],
      request: { roleId: described.data.role.id, operationId: randomUUID(), expectedRevision: 1, from, targetProviderId: 'claude' } };
    expect(await enroll({ action: 'prepare', freeze })).toMatchObject({ status: 200, data: { record: { phase: 'ready' } } });
    const committed = await enroll({ action: 'commit', freeze });
    expect(committed).toMatchObject({ status: 200, data: { record: { phase: 'committed', to: { providerId: 'claude' } } } });
    const successor: NativeSessionRef = committed.data.record.to;

    // The Team follows its Leader to Claude.
    expect(broker.list()[0]!.members[0]).toMatchObject({ providerId: 'claude', nativeSessionId: successor.nativeSessionId });
    const next = await control('/remote/attach', { providerId: 'claude', nativeSessionId: successor.nativeSessionId });
    await turn(next.agentId, 'SUCCESSOR_FIRST_PROMPT');
    const first = JSON.stringify(claudeBodies.find(body => JSON.stringify(body.messages).includes('SUCCESSOR_FIRST_PROMPT')));
    expect(first).toContain('LEADER_FIRST_PROMPT');
    expect(first).toContain('LEADER_BEFORE_HANDOFF');
    const result = JSON.stringify(claudeBodies.at(-1).messages);
    expect(result).toContain('tool_result');
    expect(result).toContain(team.id);
  } finally {
    await wire.close(); await host.close(); await claude.dispose(); await f.close();
    codexServer.closeAllConnections(); await new Promise<void>(resolve => codexServer.close(() => resolve()));
  }
}, 180000);
