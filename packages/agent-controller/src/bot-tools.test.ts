import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isBotMessageResult, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { BotTools, workerToolsIn, WORKER_NAMESPACE } from './bot-tools.js';

// The Relay names the bots' main sessions on this Host with their missions; the stub answers as it would.
function fixture(bots: Array<{ nativeSessionId: string; mission?: string }>, tasks = true) {
  const calls: TeamHostCall[] = [];
  let listed = bots;
  const tools = new BotTools({ request: async call => { calls.push(call); return { bots: listed.map(bot => ({ providerId: 'codex', ...bot })) }; }, tasks: () => tasks });
  return { tools, calls, set: (next: typeof bots) => { listed = next; } };
}
const ref = (nativeSessionId: string) => ({ controllerId: 'controller', providerId: 'codex', nativeSessionId });

it('follows the bots the Relay names, with their missions, and tells listeners when they change', async () => {
  const f = fixture([{ nativeSessionId: 'chief', mission: 'Lead the release.' }]);
  let changes = 0; f.tools.onChange(() => { changes++; });
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([{ action: 'bot_enablement' }]);
  expect(f.tools.tools(ref('chief'))).toBe('tasks');
  expect(f.tools.tools(ref('plain'))).toBe('none');
  expect(f.tools.standing(ref('chief'))).toContain('Your mission:\nLead the release.');
  expect(f.tools.standing(ref('plain'))).toBeUndefined();
  expect(changes).toBe(1);
  await f.tools.refresh('controller');
  expect(changes).toBe(1);
  f.set([{ nativeSessionId: 'chief', mission: 'Ship on Friday.' }]);
  await f.tools.refresh('controller');
  expect(changes).toBe(2);
  expect(f.tools.standing(ref('chief'))).toContain('Ship on Friday.');
});

it('offers nothing, and asks nothing, while the Relay has not acknowledged bots', async () => {
  const f = fixture([{ nativeSessionId: 'chief' }], false);
  await f.tools.refresh('controller');
  expect(f.calls).toEqual([]);
  expect(f.tools.enabled(ref('chief'))).toBe(false);
  await expect(f.tools.namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'list_bots')!.execute({})).rejects.toThrow('Update the Relay to use tasks.');
});

it('counts a listed bots namespace as the tools a session was given, and a deferred one as none', () => {
  const namespace = fixture([]).tools.namespace(() => ref('chief'), false);
  expect(namespace.name).toBe(WORKER_NAMESPACE);
  expect(workerToolsIn([namespace])).toBe('tasks');
  expect(workerToolsIn([{ ...namespace, deferred: true }])).toBe('none');
  expect(workerToolsIn(undefined)).toBe('none');
});

it('returns the outcome of a message to the bot as the tool result, whichever of the five the Relay names', async () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../agent-remote-protocol/src/fixtures/bot-messages.v1.json', import.meta.url), 'utf8')) as { results: { valid: unknown[] } };
  const answers = [...fixtures.results.valid], calls: TeamHostCall[] = [];
  const tools = new BotTools({ request: async call => { calls.push(call); return answers.shift(); }, tasks: () => true });
  const message = tools.namespace(() => ref('chief'), false).tools.find(tool => tool.name === 'message')!;
  expect(message.description).toMatch(/delivered.*held.*duplicate.*forbidden.*unreachable/s);
  const told = [];
  for (let index = 0; index < fixtures.results.valid.length; index++) told.push(JSON.parse(await message.execute({ to: 'Tracker', text: 'Hello.' }) as string));
  expect(told).toEqual(fixtures.results.valid);
  expect(told.every(isBotMessageResult)).toBe(true);
  expect(calls[0]).toMatchObject({ action: 'bot_message', to: 'Tracker', text: 'Hello.' });
});

describe('the reply a bot\'s ended turn sends', () => {
  const asked = { kind: 'framed' as const, answers: 'm0123456789ab' };
  const ended = async (turn: Parameters<BotTools['turnEnded']>[1]) => {
    const f = fixture([{ nativeSessionId: 'chief' }]);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.turnEnded(ref('chief'), turn);
    return f.calls;
  };

  it('is the final text, as a call the Host makes with no tool, when one message started the turn', async () => {
    expect(await ended({ cause: asked, tokens: 5, finalText: 'Yes, cut at noon.' })).toEqual([
      { action: 'chain_turn', owner: { providerId: 'codex', nativeSessionId: 'chief' }, cause: asked, tokens: 5 },
      { action: 'bot_reply', owner: { providerId: 'codex', nativeSessionId: 'chief' }, text: 'Yes, cut at noon.', cause: asked }]);
  });

  it('is sent for no turn that answers no message, that said nothing, or that a session without bots ran', async () => {
    expect((await ended({ cause: { kind: 'framed' }, tokens: 5, finalText: 'Done.' })).map(call => call.action)).toEqual(['chain_turn']);
    expect((await ended({ cause: { kind: 'person', messageId: 'u1' }, tokens: 5, finalText: 'Done.' })).map(call => call.action)).toEqual(['chain_turn']);
    expect((await ended({ cause: asked, tokens: 5 })).map(call => call.action)).toEqual(['chain_turn']);
    const f = fixture([{ nativeSessionId: 'chief' }]);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.turnEnded(ref('plain'), { cause: asked, tokens: 5, finalText: 'Done.' });
    expect(f.calls).toEqual([]);
  });
});

describe('what the person wrote to a bot', () => {
  it('goes to the Relay as the person\'s own words, at most 300 characters, only for a bot\'s session', async () => {
    const f = fixture([{ nativeSessionId: 'tracker' }]);
    await f.tools.refresh('controller');
    f.calls.length = 0;
    f.tools.personWrote(ref('tracker'), { messageId: 'u1', text: 'x'.repeat(1000) });
    f.tools.personWrote(ref('plain'), { messageId: 'u2', text: 'Hello.' });
    expect(f.calls).toEqual([{ action: 'bot_told', owner: { providerId: 'codex', nativeSessionId: 'tracker' }, text: 'x'.repeat(300), cause: { kind: 'person', messageId: 'u1' } }]);
  });
});
