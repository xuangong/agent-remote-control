import { join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { CopilotAgentProvider } from '../../agent-provider-copilot/src/provider.js';
import { fixture, observe, reply, waitFor } from '../../agent-provider-copilot/tests/native-fixture.js';
import { createCopilotHostRegistration } from './copilot.js';
import { createCopilotSessionDirectory } from './copilot-directory.js';
import { createAgentHostRuntime } from './host.js';
import { SessionReferenceStore } from './session-reference.js';
import { SessionSuccessionStore } from './session-succession-store.js';

it('admits the actual registered Copilot provider as a Host succession target without an extra model turn', async () => {
  const f = await fixture((body, response) => reply(response, body, 'SOURCE_READY'));
  let host: ReturnType<typeof createAgentHostRuntime> | undefined;
  try {
    const source = await f.provider.createSession({ sessionId: 'source', cwd: f.cwd, model: 'native-fixture' });
    const seen = observe(source); await source.sendMessage('Keep this requirement for the successor.');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    const id = (await source.runtimeInfo()).sessionId!;
    await f.provider.dispose(); await seen.done;
    const registration = await createCopilotHostRegistration({ copilotHome: join(f.home, 'profile'), referenceDirectory: join(f.home, 'references'), requestTimeoutMs: 5000,
      onDiagnostic: line => f.diagnostics.push(line), env: { GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
      useLoggedInUser: false, nativeSessionConfig: { provider: { type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions' } } });
    const originalOpen = registration.directory.open.bind(registration.directory);
    registration.directory.open = async (...args) => { try { return await originalOpen(...args); } catch (error) { f.diagnostics.push(String(error)); throw error; } };
    const stateDirectory = join(f.home, 'succession'), cwd = await realpath(f.cwd);
    const from = { controllerId: 'host', providerId: 'copilot', nativeSessionId: id };
    const store = new SessionSuccessionStore(join(stateDirectory, 'roles')); await store.ready;
    await store.createRole({ id: 'role', revision: 1, origin: from, current: from, workspace: { controllerId: 'host', canonicalCwd: cwd } });
    host = createAgentHostRuntime({ registrations: [registration], succession: { controllerId: 'host', stateDirectory },
      executionPolicy: { defaultWorkspace: cwd, allowedWorkspaceRoots: [cwd], lockPermissions: false } });
    const response = await host.control({ method: 'POST', path: '/remote/succession/prepare', sessionId: 'browser', body: JSON.stringify({ operationId: 'handoff', roleId: 'role', expectedRevision: 1, from, targetProviderId: 'copilot' }) });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body), `${response.body}\n${f.diagnostics.join('\n')}`).toMatchObject({ phase: 'ready', to: { providerId: 'copilot' } });
    expect(f.requests).toHaveLength(1);
    expect((await host.control({ method: 'POST', path: '/remote/succession/cancel', sessionId: 'browser', body: JSON.stringify({ operationId: 'handoff' }) })).status).toBe(200);
  } finally { await host?.close(); await f.close(); }
}, 40000);

it('restores a durable source tool after cold reader resume and reads the source without opening it', async () => {
  const f = await fixture((body, response, index) => reply(response, body,
    index === 2 || index === 4 ? { name: 'read_source_session', arguments: { query: 'SOURCE_REQUIREMENT' } } : index === 1 ? 'SOURCE_REQUIREMENT_ANSWER' : 'SOURCE_READ_COMPLETE'));
  const references = join(f.home, 'references'), owners = { root: join(f.home, 'profile', '.arc-session-owners') };
  let directory = createCopilotSessionDirectory(f.provider, [], owners, new SessionReferenceStore(references, 'copilot'));
  let restoredProvider: CopilotAgentProvider | undefined;
  try {
    const sourceId = await directory.create({ cwd: f.cwd, model: 'native-fixture' });
    const source = await directory.open(sourceId), observedSource = observe(source);
    await source.sendMessage('SOURCE_REQUIREMENT');
    await waitFor(() => observedSource.events().some(event => event.type === 'turn_completed'));
    const readerId = await directory.create({ cwd: f.cwd, model: 'native-fixture', sourceNativeSessionId: sourceId, instructions: 'Read the source when asked.' });
    const reader = await directory.open(readerId), seen = observe(reader);
    await reader.setSessionSetting!('tool_approval_mode', 'allow');
    await reader.sendMessage('Read the source now.');
    await waitFor(() => seen.events().some(event => event.type === 'turn_completed'));
    expect(JSON.stringify(f.requests[2]?.messages.filter(message => message.role === 'tool').at(-1))).toContain('SOURCE_REQUIREMENT_ANSWER');
    expect(await directory.sourceReferences!()).toEqual([{ nativeSessionId: readerId, sourceNativeSessionId: sourceId }]);
    await directory.close(); await Promise.all([observedSource.done, seen.done]);
    const sourcePath = join(f.home, 'profile', 'session-state', sourceId, 'events.jsonl'), sourceHistory = await readFile(sourcePath);
    restoredProvider = new CopilotAgentProvider({ useLoggedInUser: false, requestTimeoutMs: 5000,
      env: { COPILOT_HOME: join(f.home, 'profile'), GITHUB_TOKEN: undefined, GH_TOKEN: undefined, COPILOT_GITHUB_TOKEN: undefined },
      nativeSessionConfig: { provider: { type: 'openai', baseUrl: f.baseUrl, wireApi: 'completions' } } });
    directory = createCopilotSessionDirectory(restoredProvider, [], owners, new SessionReferenceStore(references, 'copilot'));
    const reopened = await directory.open(readerId), restored = observe(reopened);
    await waitFor(() => restored.items.some(item => item.type === 'history_boundary'));
    const completed = restored.events().filter(event => event.type === 'turn_completed').length;
    await reopened.sendMessage('Read the source again after restart.');
    await waitFor(() => restored.events().some(event => event.type === 'interaction_requested'));
    const approval = restored.events().find(event => event.type === 'interaction_requested');
    if (approval?.type !== 'interaction_requested') throw new Error('Expected native tool approval after restart.');
    await reopened.respondToInteraction(approval.request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
    await waitFor(() => restored.events().filter(event => event.type === 'turn_completed').length > completed).catch(error => {
      throw new Error(`${String(error)}\n${JSON.stringify({ events: restored.events(), requests: f.requests.length, diagnostics: f.diagnostics })}`);
    });
    expect(JSON.stringify(f.requests[4]?.messages.filter(message => message.role === 'tool').at(-1))).toContain('SOURCE_REQUIREMENT_ANSWER');
    expect(await readFile(sourcePath)).toEqual(sourceHistory);
    expect(await directory.sourceReferences!()).toEqual([{ nativeSessionId: readerId, sourceNativeSessionId: sourceId }]);
    expect(f.requests).toHaveLength(5); expect(f.errors).toEqual([]);
  } finally { await directory.close(); await restoredProvider?.dispose(); await f.close(); }
}, 40000);
