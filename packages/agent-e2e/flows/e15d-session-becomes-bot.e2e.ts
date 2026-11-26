// E15d, a plain session becomes a bot while it runs (bots design 5.1). The scripted provider declares live tools (`toolNamespaces: 'live'`).
// A session that the page has opened is put into a group as a bot with a mission: the Controller gives it the bots' tools and its standing
// instructions without reopening it, so its next turn can call `message` and the other bot receives what it says.
import { randomUUID } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createWindowView } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { inputs } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { showsText } from './page.js';

let stack: Stack; let browser: Browser;
beforeEach(async () => {
  stack = await startStack({ teams: true, tools: true, sessions: {
    plain: { title: 'Plain', history: [{ role: 'user', text: 'Keep the notes.' }, { role: 'assistant', text: 'Plain is ready.' }] },
    peer: { title: 'Peer', history: [{ role: 'user', text: 'Watch the build.' }, { role: 'assistant', text: 'Peer is ready.' }] },
  } });
  browser = await launchBrowser();
});
afterEach(async () => { await browser?.close(); await stack?.close(); });

for (const peerOpened of [true, false]) it(`E15d: a plain session put into a group as a bot gets its tools and standing instructions while it runs, and its next turn messages the other bot (peer ${peerOpened ? 'opened in a page' : 'never opened'})`, async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('plain'));
  await showsText(page, 'Plain is ready.');
  // The session runs as a plain one: the page opened it, and nothing gave it the bots' tools or instructions.
  await expect.poll(() => stack.provider.session('plain'), { timeout: 20_000 }).toBeDefined();
  const running = stack.provider.session('plain')!;
  expect(stack.provider.given('plain')?.tools.map(tool => tool.name) ?? []).not.toContain('message');
  const before = running.sent.length;
  // The other session runs too, opened in a page of its own, or never opened: a bot that a person or another bot created has no page.
  if (peerOpened) {
    const other = await context.newPage();
    await other.goto(stack.sessionUrl('peer'));
    await showsText(other, 'Peer is ready.');
  }

  // The person groups it with another session as bots, and gives it a mission.
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const groups = stack.origin + status.basePath + 'v1/windows';
  const binding = (nativeSessionId: string, title: string) => ({ hostId: stack.hostId, providerId: stack.provider.providerId, nativeSessionId, title });
  const id = randomUUID();
  const created = await context.request.post(groups, { headers: { origin: stack.origin }, data: { operationId: randomUUID(), issuedAt: Date.now(),
    window: { schemaVersion: 3, id, title: 'Notes', revision: 0, selectedPrimaryViewId: 'plain', selectedViewId: 'plain',
      views: [createWindowView('plain', binding('plain', 'Plain'), 'primary'), createWindowView('peer', binding('peer', 'Peer'), 'primary')] },
    bots: { rank: 'm', members: { plain: { name: 'Plain', mission: 'Keep the release notes.' }, peer: { name: 'Peer' } } } } });
  expect(created.ok()).toBe(true);
  // Its standing instructions arrive as an input of the running session, and the bots' tools with them.
  await expect.poll(() => running.sent.slice(before).some(text => text.includes('[Your standing instructions') && text.includes('Keep the release notes.')), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => stack.provider.given('plain')?.tools.map(tool => tool.name) ?? [], { timeout: 20_000 }).toContain('message');

  // Its next turn calls message, and the other bot receives it.
  expect(await stack.provider.useTool('plain', 'message', { to: 'Peer', text: 'The notes are in docs/notes.md.' })).toMatchObject({ outcome: 'delivered' });
  await expect.poll(() => inputs(stack, 'peer').filter(input => input.kind === 'assistant'), { timeout: 20_000 })
    .toEqual([expect.objectContaining({ from: 'Plain', body: 'The notes are in docs/notes.md.' })]);

  // The session was never reopened: the provider still holds the session it had, and it was never opened with these instructions.
  expect(stack.provider.session('plain')).toBe(running);
  expect(stack.provider.given('plain')?.instructions).toBeUndefined();
  await context.close();
});
