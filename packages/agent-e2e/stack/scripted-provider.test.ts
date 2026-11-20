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
  expect(run.events()).toEqual(['turn_started', 'user_message', 'tool_call:running', 'tool_call:completed', 'assistant_message', 'turn_completed']);
  const turnIds = new Set(run.seen.map(({ event }) => (event as { turnId?: string }).turnId));
  expect(turnIds.size).toBe(1);
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
  expect(run.events()).toEqual(['turn_started', 'user_message', 'interaction_requested']);
  const request = (run.seen[2]!.event as Extract<ProviderObservation['event'], { type: 'interaction_requested' }>).request;
  expect(request).toMatchObject({ kind: 'tool_approval', summary: 'Write a file', detail: { type: 'shell', command: 'touch a' } });
  await run.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'allow', scope: 'once' });
  await run.settle();
  expect(run.events().slice(3)).toEqual(['interaction_resolved', 'assistant_message', 'turn_completed']);
  expect(run.seen[3]!.itemIdentity).toEqual({ key: `interaction:${request.requestId}`, completes: true, liveOnly: true });
  await run.close();
});

it('ends the turn at a denied approval', async () => {
  const run = await opened(() => [{ approval: 'Delete', command: 'rm a' }, { reply: 'Never said' }]);
  await run.session.sendMessage('delete');
  await run.settle();
  const request = (run.seen[2]!.event as Extract<ProviderObservation['event'], { type: 'interaction_requested' }>).request;
  await run.session.respondToInteraction(request.requestId, { kind: 'tool_approval', decision: 'deny' });
  await run.settle();
  expect(run.events().slice(3)).toEqual(['interaction_resolved', 'turn_completed']);
  await run.close();
});
