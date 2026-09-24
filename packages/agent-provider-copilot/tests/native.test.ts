import {createHash} from 'node:crypto';
import {writeMcpFormServer} from '../../agent-provider-claude/src/test-utils/mcp-elicitation.js';
import {expect, it} from 'vitest';
import {ResourceIngestor} from '../../agent-remote-relay/src/resources/resource-ingestor.js';
import {InMemoryResourceStore} from '../../agent-remote-relay/src/resources/resource-store.js';
import {mkdir, writeFile, readFile, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {homedir} from 'node:os';
import type {ServerResponse} from 'node:http';
import {fixture, observe, reply, waitFor, type ModelRequest} from './native-fixture.js';

it('native apply_patch retains file diffs through Relay projection and saved resume', async () => {
 const f = await fixture((body, res, index) => {
  if (index === 1) {
   reply(res, body, {name: 'apply_patch', arguments: {input: '*** Begin Patch\n*** Add File: result.md\n+# Native diff\n*** End Patch'}});
  } else reply(res, body, 'PATCH_DONE');
 });
 try {
  const session = await f.provider.createSession({sessionId: 'patch', cwd: f.cwd, model: 'gpt-5.4'});
  const seen = observe(session);
  await session.setSessionSetting!('tool_approval_mode', 'allow');
  await session.sendMessage('Create result.md with the native patch tool.');
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  const item = seen.timeline().find(e => e.item.type === 'tool_call')?.item;
  expect(item).toMatchObject({status: 'completed', detail: {type: 'write', filePath: 'result.md'}, result: {content: expect.arrayContaining([
   {type: 'json', value: {format: 'file_changes', version: 1, files: [expect.objectContaining({path: await realpath(join(f.cwd, 'result.md')), kind: 'added', diff: expect.stringContaining('+# Native diff')})]}},
  ])}});
  expect((await readFile(join(f.cwd, 'result.md'), 'utf8')).trim()).toBe('# Native diff');
  const handle = (await session.runtimeInfo()).persistence!;
  await session.dispose(); await seen.done;
  const resumed = await f.provider.resumeSession(handle); const history = observe(resumed);
  await waitFor(() => history.items.some(i => i.type === 'history_boundary'));
  expect(history.timeline().find(e => e.item.type === 'tool_call')?.item).toEqual(item);
  await resumed.dispose(); await history.done;
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
}, 45000);

it.each(['next_turn', 'immediate'] as const)('native SDK preserves %s interactions through live and resumed history', async delivery => {
 let held: {res: ServerResponse; body: ModelRequest} | undefined;
 const f = await fixture((body, res, index) => { if (index === 1) held = {body, res}; else reply(res, body, 'SECOND_REPLY'); });
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  await session.sendMessage('FIRST_INPUT'); await waitFor(() => held);
  await session.sendMessage('SECOND_INPUT', {delivery});
  expect(f.requests).toHaveLength(1);
  reply(held!.res, held!.body, delivery === 'immediate' ? {name: 'bash', arguments: {command: 'echo STEERING_OK', description: 'Print marker'}} : 'FIRST_REPLY');
  if (delivery === 'immediate') {
   await waitFor(() => seen.events().some(e => e.type === 'interaction_requested'));
   const request = seen.events().find(e => e.type === 'interaction_requested')!;
   if (request.type !== 'interaction_requested') throw new Error('Missing approval');
   await session.respondToInteraction(request.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
  }
  const count = delivery === 'next_turn' ? 2 : 1;
  await waitFor(() => seen.events().filter(e => e.type === 'turn_completed').length === count);
  expect(seen.events().filter(e => e.type === 'turn_started')).toHaveLength(count);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('SECOND_INPUT');
  const persistence = (await session.runtimeInfo()).persistence!;
  await waitFor(async () => (await f.provider.listSessions()).some(s => s.nativeSessionId === persistence.sessionId));
  await session.dispose(); await seen.done;
  const resumed = await f.provider.resumeSession(persistence); const history = observe(resumed);
  await waitFor(() => history.items.some(i => i.type === 'history_boundary'));
  expect(history.events().filter(e => e.type === 'turn_started')).toHaveLength(count);
  expect(history.events().filter(e => e.type === 'turn_completed')).toHaveLength(count);
  for (const events of [seen.events(), history.events()]) {
   const starts = events.filter(e => e.type === 'turn_started');
   const users = events.filter(e => e.type === 'timeline' && e.item.type === 'user_message');
   expect(users.map(e => e.turnId)).toEqual([starts[0]!.turnId, starts[count - 1]!.turnId]);
  }
  for (const observation of [seen, history]) {
   expect(observation.timeline().filter(e => e.item.type === 'assistant_message').map(e => e.item.type === 'assistant_message' ? e.item.text : '')).toEqual(delivery === 'next_turn' ? ['FIRST_REPLY', 'SECOND_REPLY'] : ['SECOND_REPLY']);
   if (delivery === 'immediate') expect(observation.timeline().find(e => e.item.type === 'tool_call')?.item).toMatchObject({status: 'completed', result: {content: expect.arrayContaining([expect.objectContaining({text: expect.stringContaining('STEERING_OK')})])}});
  }
  if (delivery === 'immediate') expect(history.timeline()).toContainEqual(expect.objectContaining({item: expect.objectContaining({type: 'interaction', request: expect.objectContaining({kind: 'tool_approval'}), response: {kind: 'tool_approval', decision: 'allow', scope: 'once'}})}));
  expect(f.errors).toEqual([]);
 } finally { await f.close(); }
}, 45000);

it('native skills expand body and arguments; multi-step questions and approvals finish one turn', async () => {
 const f = await fixture((body, res, index) => reply(res, body, index === 1 ? {name: 'ask_user', arguments: {question: 'Choose a marker', choices: ['BLUE', 'GREEN'], allow_freeform: true}} : index === 2 ? {name: 'bash', arguments: {command: 'echo APPROVAL_OK', description: 'Print marker'}} : 'FINAL_REPLY'));
 try {
  const skill = join(f.cwd, '.github/skills/probe'); await mkdir(skill, {recursive: true});
  await writeFile(join(skill, 'SKILL.md'), '---\nname: probe\ndescription: Fixture skill\n---\nSKILL_BODY_MARKER\n');
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  expect((await session.listCommands!()).some(c => c.id === 'probe')).toBe(true);
  const resource = await session.readResource!('copilot:skill:probe'); expect(resource.status).toBe('available');
  const ingestor = new ResourceIngestor({store: new InMemoryResourceStore()});
  const acquired = ingestor.acquire({agentId: 'native-root', locator: 'skill.md', readLocator: 'copilot:skill:probe', reader: locator => session.readResource!(locator)});
  expect(acquired).toBeDefined(); await acquired!.settled;
  expect(ingestor.readResponse('read', 'native-root', acquired!.binding.resourceId).payload.state).toMatchObject({status: 'available', mediaType: 'text/plain', contentBase64: Buffer.from('---\nname: probe\ndescription: Fixture skill\n---\nSKILL_BODY_MARKER\n').toString('base64')});
  await session.executeCommand!('probe', 'SKILL_ARG_MARKER');
  await waitFor(() => seen.events().some(e => e.type === 'interaction_requested'));
  let request = seen.events().find(e => e.type === 'interaction_requested')!;
  if (request.type !== 'interaction_requested') throw new Error('Missing question');
  expect(request.request.kind).toBe('question');
  await session.respondToInteraction(request.request.requestId, {kind: 'question', answers: [{questionId: request.request.kind === 'question' ? request.request.questions[0]!.questionId : '', selectedValues: ['BLUE']}]});
  await waitFor(() => seen.events().filter(e => e.type === 'interaction_requested').length === 2);
  request = seen.events().filter(e => e.type === 'interaction_requested')[1]!;
  if (request.type !== 'interaction_requested') throw new Error('Missing approval');
  await session.respondToInteraction(request.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(seen.events().filter(e => e.type === 'turn_started')).toHaveLength(1);
  expect(JSON.stringify(f.requests[0]?.messages)).toContain('SKILL_BODY_MARKER'); expect(JSON.stringify(f.requests[0]?.messages)).toContain('SKILL_ARG_MARKER');
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('APPROVAL_OK'); expect(f.errors).toEqual([]);
 } finally { await f.close(); }
}, 45000);

it('native child repeat input and successful child tool approval survive root cancellation', async () => {
 let childApprovalSent = false;
 const f = await fixture((body, res, index) => {
  const childRequest = !childApprovalSent && body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('CHILD_FIRST_INPUT'));
  if (childRequest) childApprovalSent = true;
  reply(res, body, index === 1 ? {name: 'task', arguments: {name: 'Native child', description: 'Fixture child', prompt: 'CHILD_FIRST_INPUT', agent_type: 'general-purpose', model: 'gpt-4.1', mode: 'background'}} : childRequest ? {name: 'bash', arguments: {command: 'echo CHILD_PERMISSION_OK', description: 'Print child marker'}} : `REPLY_${index}`);
 });
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  await session.sendMessage('SPAWN_CHILD');
  await waitFor(async () => (await session.runtimeInfo()).childSessions?.length);
  const info = await session.runtimeInfo(); const id = info.childSessions![0]!.nativeSessionId;
  const child = await f.provider.openChildSession(info.sessionId, id); const childSeen = observe(child);
  await waitFor(() => seen.events().some(e => e.type === 'interaction_requested'));
  const request = seen.events().find(e => e.type === 'interaction_requested')!;
  if (request.type !== 'interaction_requested') throw new Error('Missing child approval');
  await session.cancel();
  expect(seen.events().some(e => e.type === 'interaction_resolved' && e.requestId === request.request.requestId)).toBe(false);
  await session.respondToInteraction(request.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
  await waitFor(() => childSeen.events().some(e => e.type === 'timeline' && e.item.type === 'tool_call' && e.item.name === 'bash' && e.item.status === 'completed'));
  expect(JSON.stringify(childSeen.events())).toContain('CHILD_PERMISSION_OK');
  await waitFor(() => childSeen.events().some(e => e.type === 'turn_completed'));
  await child.sendMessage('CHILD_SECOND_INPUT');
  await waitFor(() => childSeen.events().filter(e => e.type === 'turn_completed').length === 2);
  const starts = childSeen.events().filter(e => e.type === 'turn_started');
  expect(starts).toHaveLength(2); expect(starts[0]?.turnId).not.toBe(starts[1]?.turnId);
  expect(childSeen.events().some(e => e.type === 'interaction_requested')).toBe(false);
  await child.dispose(); await childSeen.done;
  const reopened = await f.provider.openChildSession(info.sessionId, id); const history = observe(reopened);
  await waitFor(() => history.items.some(i => i.type === 'history_boundary'));
  expect(history.events().filter(e => e.type === 'turn_started')).toHaveLength(2);
  expect(history.events().filter(e => e.type === 'turn_completed')).toHaveLength(2);
  for (const observation of [childSeen, history]) {
   const messages = observation.timeline().filter(e => e.item.type === 'assistant_message');
   expect(messages).toHaveLength(2);
   for (const message of messages) expect(message.item).toMatchObject({text: expect.stringMatching(/^REPLY_\d+$/)});
   expect(observation.timeline().find(e => e.item.type === 'tool_call' && e.item.name === 'bash')?.item).toMatchObject({status: 'completed', result: {content: expect.arrayContaining([expect.objectContaining({text: expect.stringContaining('CHILD_PERMISSION_OK')})])}});
  }
  expect(f.errors).toEqual([]);
 } finally { await f.close(); }
}, 45000);

it('native plan mode emits a normalized approval and accepts rejection feedback', async () => {
 const f = await fixture((body, res, index) => reply(res, body, index === 1 ? {name: 'exit_plan_mode', arguments: {summary: 'Fixture plan ready'}} : 'PLAN_FEEDBACK_RECEIVED'));
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1', planning: true}); const seen = observe(session);
  expect((await session.runtimeInfo()).planning).toEqual({active: true});
  await session.sendMessage('Propose the fixture plan.');
  await waitFor(() => seen.events().some(e => e.type === 'interaction_requested' && e.request.kind === 'plan_approval'));
  const request = seen.events().find(e => e.type === 'interaction_requested' && e.request.kind === 'plan_approval')!;
  if (request.type !== 'interaction_requested') throw new Error('Missing plan approval');
  await session.respondToInteraction(request.request.requestId, {kind: 'plan_approval', action: 'reject', feedback: 'Keep planning; add tests.'});
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('Keep planning; add tests.');
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
}, 45000);

it('native image input survives normalized history and resource ingestion', async () => {
 const f = await fixture((body, res) => reply(res, body, 'IMAGE_RECEIVED'));
 try {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZuoAAAAASUVORK5CYII=', 'base64');
  const path = join(f.cwd, 'pixel.png'); await writeFile(path, bytes);
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  expect(session.capabilities.imageInput).toBeDefined();
  await session.sendMessageContent!([{type: 'text', text: 'Inspect'}, {type: 'image', path, mediaType: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex'), label: 'pixel.png'}]);
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(JSON.stringify(f.requests[0]?.messages)).toContain('data:image/png;base64,');
  const image = seen.items.flatMap(i => i.type === 'observation' ? i.resourceReferences ?? [] : [])[0]!;
  expect(image).toBeDefined(); expect(await session.readResource!(image.readLocator)).toMatchObject({status: 'available', mediaType: 'image/png', bytes});
  const persistence = (await session.runtimeInfo()).persistence!; await session.dispose(); await seen.done;
  const resumed = await f.provider.resumeSession(persistence); const history = observe(resumed);
  await waitFor(() => history.items.some(i => i.type === 'history_boundary'));
  const historical = history.items.flatMap(i => i.type === 'observation' ? i.resourceReferences ?? [] : [])[0]!;
  expect(historical.locator).toBe(image.locator);
  expect(await resumed.readResource!(historical.readLocator)).toMatchObject({status: 'available', mediaType: 'image/png', bytes});
 } finally {await f.close();}
}, 45000);
it('native MCP form roundtrip uses the normalized interaction contract', async () => {
 let resultPath = '';
 const f = await fixture((body, res, index) => {
  const tools = (body as ModelRequest & {tools: {function: {name: string}}[]}).tools;
  const name = tools.find(t => t.function.name.includes('collect_preferences'))?.function.name;
  reply(res, body, index === 1 && name ? {name, arguments: {}} : 'FORM_RECEIVED');
 }, async cwd => {
  const files = await writeMcpFormServer(cwd, {type: 'object', properties: {name: {type: 'string', minLength: 2}, token: {type: 'string', writeOnly: true}}, required: ['name']}); resultPath = files.resultPath;
  return {mcpServers: {fixture: {command: process.execPath, args: [files.serverPath], tools: ['*']}}};
 });
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  await session.sendMessage('Collect preferences.');
  await waitFor(async () => {
   for (const e of seen.events()) if (e.type === 'interaction_requested' && e.request.kind === 'tool_approval' && !seen.events().some(r => r.type === 'interaction_resolved' && r.requestId === e.request.requestId)) await session.respondToInteraction(e.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'once'});
   return seen.events().some(e => e.type === 'interaction_requested' && e.request.kind === 'form');
  });
  const request = seen.events().find(e => e.type === 'interaction_requested' && e.request.kind === 'form')!;
  if (request.type !== 'interaction_requested') throw new Error('Missing form');
  expect(request.request).toMatchObject({fields: expect.arrayContaining([expect.objectContaining({fieldId: 'token', sensitive: true})])});
  await session.respondToInteraction(request.request.requestId, {kind: 'form', action: 'submit', values: {name: 'Alice'}});
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(JSON.parse(await readFile(resultPath, 'utf8')).result).toMatchObject({action: 'accept', content: {name: 'Alice'}});
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
}, 45000);

it('native SQL todo updates produce normalized task snapshots', async () => {
 const f = await fixture((body, res, index) => reply(res, body, index === 1 ? {name: 'sql', arguments: {description: 'Update fixture todos', query: "CREATE TABLE IF NOT EXISTS todos (id TEXT PRIMARY KEY, title TEXT, description TEXT, status TEXT); INSERT INTO todos (id, title, status) VALUES ('fixture', 'Verify normalized todos', 'in_progress');"}} : 'TODOS_UPDATED'));
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  await session.sendMessage('Update the session todo list.');
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(seen.events()).toContainEqual(expect.objectContaining({type: 'timeline', item: {type: 'todo', items: [expect.objectContaining({id: 'fixture', text: 'Verify normalized todos', status: 'in_progress', completed: false})]}}));
 } finally {await f.close();}
}, 45000);

it('native tool approval policy runs tools without a prompt and can be disabled', async () => {
 const f = await fixture((body, res, index) => reply(res, body, index === 1 ? {name: 'bash', arguments: {command: 'echo PERMISSION_MODE_OK', description: 'Print permission marker'}} : 'MODE_COMPLETE'));
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  const mode = async () => (await session.runtimeInfo()).settings?.find(s => s.id === 'tool_approval_mode')?.value;
  expect(await mode(), f.diagnostics.join('\n')).toBe('ask');
  await session.setSessionSetting!('tool_approval_mode', 'allow'); expect(await mode()).toBe('allow');
  await session.sendMessage('Print the permission marker.');
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(seen.events().filter(e => e.type === 'interaction_requested')).toEqual([]);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('PERMISSION_MODE_OK');
  await session.setSessionSetting!('tool_approval_mode', 'ask'); expect(await mode(), f.diagnostics.join('\n')).toBe('ask');
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
}, 45000);

it('native path and read-tool session grants prevent repeated approvals for the next read', async () => {
 let file = '';
 const f = await fixture((body, res, index) => reply(res, body, index <= 2 ? {name: 'view', arguments: {path: file}} : 'READS_COMPLETE'));
 const outside = await import('node:fs/promises').then(fs => fs.mkdtemp(join(homedir(), '.arc-permission-test-')));
 file = join(outside, 'outside.txt'); await writeFile(file, 'READ_SESSION_MARKER');
 try {
  const session = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const seen = observe(session);
  await session.sendMessage('Read the fixture file twice.');
  await waitFor(() => seen.events().some(e => e.type === 'interaction_requested'));
  const path = seen.events().find(e => e.type === 'interaction_requested')!;
  if (path.type !== 'interaction_requested') throw new Error('Missing path approval');
  expect(path.request).toMatchObject({toolName: 'Path access', allowScopes: ['once', 'session']});
  await session.respondToInteraction(path.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'session'});
  await waitFor(() => seen.events().filter(e => e.type === 'interaction_requested').length >= 2);
  const read = seen.events().filter(e => e.type === 'interaction_requested')[1]!;
  if (read.type !== 'interaction_requested') throw new Error('Missing read approval');
  expect(read.request).toMatchObject({toolName: 'read', allowScopes: ['once', 'session']});
  await session.respondToInteraction(read.request.requestId, {kind: 'tool_approval', decision: 'allow', scope: 'session'});
  await waitFor(() => seen.events().some(e => e.type === 'turn_completed'));
  expect(seen.events().filter(e => e.type === 'interaction_requested')).toHaveLength(2);
  expect(seen.events().filter(e => e.type === 'interaction_resolved').map(e => e.response)).toEqual([
   {kind: 'tool_approval', decision: 'allow', scope: 'session'}, {kind: 'tool_approval', decision: 'allow', scope: 'session'},
  ]);
  expect(seen.timeline().filter(e => e.item.type === 'tool_call' && e.item.status === 'completed')).toHaveLength(2);
  expect(f.errors).toEqual([]);
 } finally {await f.close(); await import('node:fs/promises').then(fs => fs.rm(outside, {recursive: true, force: true}));}
}, 45000);
