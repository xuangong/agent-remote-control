// What the bot flows share: a group of the account with two bots, and reads of what a bot's scripted session was given.
import { randomUUID } from 'node:crypto';
import type { BrowserContext } from '@playwright/test';
import { expect } from 'vitest';
import { createWindowView, parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import type { Stack } from '@orchardworks/agent-e2e/stack';
import { resetWindows } from './browser.js';

/** One group of the account with Chief and Tracker as its bots, from a Window that holds nothing else. */
export async function team(stack: Stack, context: BrowserContext): Promise<string> {
  await resetWindows(context, stack.origin);
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const binding = (nativeSessionId: string, title: string) => ({ hostId: stack.hostId, providerId: stack.provider.providerId, nativeSessionId, title });
  const id = randomUUID();
  const response = await context.request.post(stack.origin + status.basePath + 'v1/windows', { headers: { origin: stack.origin }, data: { operationId: randomUUID(), issuedAt: Date.now(),
    window: { schemaVersion: 3, id, title: 'Release', revision: 0, selectedPrimaryViewId: 'chief', selectedViewId: 'chief',
      views: [createWindowView('chief', binding('chief', 'Chief'), 'primary'), createWindowView('tracker', binding('tracker', 'Tracker'), 'primary')] },
    bots: { rank: 'm', members: { chief: { name: 'Chief' }, tracker: { name: 'Tracker' } } } } });
  if (!response.ok()) throw new Error(`The team group could not be created (${response.status()}).`);
  return id;
}
/** A bot's tools arrive once the Controller has read which sessions are bots. */
export const hasTools = (stack: Stack, nativeSessionId: string) => expect.poll(() => stack.provider.given(nativeSessionId)?.tools.map(tool => tool.name) ?? [], { timeout: 20_000 }).toContain('create_bot');
export const inputs = (stack: Stack, nativeSessionId: string) => stack.provider.session(nativeSessionId)?.sent.flatMap(text => parseTaskInputs(text) ?? []) ?? [];
