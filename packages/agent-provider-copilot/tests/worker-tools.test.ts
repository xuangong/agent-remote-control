import {expect, it} from 'vitest';
import {fixture, observe, reply, waitFor} from './native-fixture.js';

const schema = {type: 'object', properties: {role: {type: 'string'}}, required: ['role'], additionalProperties: false};

it('native resume gives a session started without them the tools of a namespace, which the model calls without a prompt', async () => {
 const calls: unknown[] = [];
 const f = await fixture((body, res) => {
  const last = body.messages.at(-1);
  reply(res, body, last?.role === 'user' && JSON.stringify(last.content).includes('Call for support') ? {name: 'call_for_support', arguments: {role: 'code reviewer'}} : 'DONE');
 });
 try {
  const first = await f.provider.createSession({sessionId: 'public', cwd: f.cwd, model: 'gpt-4.1'}); const before = observe(first);
  await first.sendMessage('Hello.');
  await waitFor(() => before.events().some(e => e.type === 'turn_completed'));
  const handle = (await first.runtimeInfo()).persistence!;
  await first.dispose();
  const session = await f.provider.resumeSession(handle, {toolNamespaces: [{name: 'agent_remote', description: 'Agent Remote Control', tools: [
   {name: 'call_for_support', description: 'Call for support from other sessions.', inputSchema: schema, execute: async args => { calls.push(args); return 'CALL_ACCEPTED call-789'; }}]}]});
  const seen = observe(session);
  await session.sendMessage('Call for support.');
  // The resumed session replays the earlier turn; this turn ends once the model has read the tool's result.
  await waitFor(() => JSON.stringify(f.requests.at(-1)?.messages ?? []).includes('CALL_ACCEPTED'));
  expect(seen.events().filter(e => e.type === 'interaction_requested')).toEqual([]);
  expect(calls).toEqual([{role: 'code reviewer'}]);
  expect(JSON.stringify(f.requests.at(-1)?.messages)).toContain('CALL_ACCEPTED call-789');
  await session.dispose();
  expect(f.errors).toEqual([]);
 } finally {await f.close();}
}, 60000);
