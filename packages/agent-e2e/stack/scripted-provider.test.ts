import { expect, it } from 'vitest';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';
import { scriptedProvider, type ScriptedStep } from './scripted-provider.js';

/** A session of the provider, its live observations collected as they arrive, and a way to send a text through the provider's own path. */
async function opened(turns: (text: string) => ScriptedStep[]) {
  const provider = scriptedProvider({ sessions: { s1: { title: 'One', history: [] } }, turns });
  const session = await provider.registration.directory.open('s1') as unknown as {
    observe(): AsyncIterable<unknown>; sendMessage(text: string): Promise<void>; respondToInteraction(id: string, response: unknown): Promise<void>;
  };
  const seen: ProviderObservation[] = [];
  const reading = (async () => { for await (const item of session.observe()) if ((item as ProviderObservation).delivery === 'live') seen.push(item as ProviderObservation); })();
  const events = () => seen.map(({ event }) => event.type === 'timeline' ? `${event.item.type}${'status' in event.item ? `:${event.item.status}` : ''}` : event.type);
  const settle = () => new Promise(resolve => setTimeout(resolve, 5));
  return { session, seen, events, settle, close: async () => { await provider.registration.directory.close(); await reading; } };
}

it('plays tool steps and a reply as one turn: a running row, the completed row under the same key, then the reply', async () => {
  const run = await opened(() => [{ tool: 'command', input: 'ls', output: 'a.txt', ms: 1 }, { reply: 'Done' }]);
  await run.session.sendMessage('list files');
  await run.settle();
  expect(run.events()).toEqual(['runtime_updated', 'turn_started', 'user_message', 'tool_call:running', 'tool_call:completed', 'assistant_message', 'turn_completed', 'runtime_updated']);
  const turnIds = new Set(run.seen.flatMap(({ event }) => event.type === 'runtime_updated' ? [] : [(event as { turnId?: string }).turnId]));
  expect(turnIds.size).toBe(1);
  // The session says it runs that turn while the turn plays, and idles after it, as a real provider does.
  const [started, ended] = run.seen.filter(({ event }) => event.type === 'runtime_updated').map(({ event }) => event as Extract<ProviderObservation['event'], { type: 'runtime_updated' }>);
  expect(started).toMatchObject({ runtimeInfo: { status: 'running' }, activeTurnId: [...turnIds][0] });
  expect(ended).toMatchObject({ runtimeInfo: { status: 'idle' }, activeTurnId: null });
  const [running, completed] = run.seen.filter(({ event }) => event.type === 'timeline' && event.item.type === 'tool_call');
  expect(running!.itemIdentity).toEqual({ key: completed!.itemIdentity!.key });
  expect(completed!.itemIdentity!.completes).toBe(true);
  expect(completed!.event).toMatchObject({ item: { detail: { type: 'shell', command: 'ls' }, result: { content: [{ type: 'text', text: 'a.txt' }] } } });
  await run.close();
});

it('holds an approval until the page answers it, then goes on after an allow', async () => {
  const run = await opened(() => [{ approval: 'Write a file', command: 'touch a' }, { reply: 'Written' }]);
  await run.session.sendMessage('write');
  await run.settle();
  expect(run.events()).toEqual(['runtime_updated', 'turn_started', 'user_message', 'interaction_requested']);
  const request = (run.seen[3]!.event as Extract<ProviderObservation['event'], { type: 'interaction_requested' }>).request;
  expect(request).toMatchObject({ kind: 'tool_approval', summary: 'Write a file', detail: { type: 'shell', command: 'touch a' } });
  await run.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
  await run.settle();
  expect(run.events().slice(4)).toEqual(['interaction_resolved', 'assistant_message', 'turn_completed', 'runtime_updated']);
  expect(run.seen[4]!.itemIdentity).toEqual({ key: `interaction:${request.requestId}`, completes: true, liveOnly: true });
  await run.close();
});

it('ends the turn at a denied approval', async () => {
  const run = await opened(() => [{ approval: 'Delete', command: 'rm a' }, { reply: 'Never said' }]);
  await run.session.sendMessage('delete');
  await run.settle();
  const request = (run.seen[3]!.event as Extract<ProviderObservation['event'], { type: 'interaction_requested' }>).request;
  await run.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'deny' });
  await run.settle();
  expect(run.events().slice(4)).toEqual(['interaction_resolved', 'turn_completed', 'runtime_updated']);
  await run.close();
});

it('gives a message written while a reply streams a key of its own, so the reply never overwrites its row (O57)', async () => {
  const provider = scriptedProvider({ stream: true, replyDelayMs: 20, sessions: { s1: { title: 'One', history: [{ role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Hi' }] } } });
  const session = await provider.registration.directory.open('s1') as unknown as { observe(): AsyncIterable<unknown>; sendMessage(text: string): Promise<void> };
  const seen: ProviderObservation[] = [];
  const reading = (async () => { for await (const item of session.observe()) if ((item as ProviderObservation).delivery === 'live') seen.push(item as ProviderObservation); })();
  await session.sendMessage('First');
  await session.sendMessage('Second');
  await new Promise(resolve => setTimeout(resolve, 60));
  const items = new Map<string, string[]>();
  for (const { event, itemIdentity } of seen) if (event.type === 'timeline' && itemIdentity) items.set(itemIdentity.key, [...items.get(itemIdentity.key) ?? [], event.item.type]);
  // Each key holds rows of one kind of item: the two user messages and the two streamed replies are four items.
  expect([...items.values()].map(types => [...new Set(types)])).toEqual([['user_message'], ['assistant_message'], ['user_message'], ['assistant_message']]);
  await provider.registration.directory.close(); await reading;
});
