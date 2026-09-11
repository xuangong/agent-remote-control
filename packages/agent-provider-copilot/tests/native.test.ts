import {expect, it} from 'vitest';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {ServerResponse} from 'node:http';
import {fixture, observe, reply, waitFor, type ModelRequest} from './native-fixture.js';

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
  expect(f.errors).toEqual([]);
 } finally { await f.close(); }
}, 45000);
