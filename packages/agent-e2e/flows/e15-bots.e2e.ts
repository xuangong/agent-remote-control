// E15, bots that call bots (bots design 11): the real page, Relay and Controller, with scripted sessions that take tools. A flow calls a
// bot's tool in its model's place (`useTool`); everything the call causes runs for real: tasks and their workers, inboxes, framed inputs,
// delivery between turns, and a standing bot joining its chief's group.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, inputs as inputsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { holdsText, showsText, waitForEntries } from './page.js';

/**
 * Enter submits what the page has rendered of the draft: a key that comes in the same frame as the last typed character reaches a
 * composer that has not rendered it yet, and sends nothing. A flow lets the composer show the draft, ready to send, before it presses Enter.
 */
async function holdsComposerText(page: Page, bot: string, text: string): Promise<void> {
  await page.waitForFunction(({ bot, text }) => {
    const input = document.querySelector(`[data-testid="prompt-input"][data-placeholder^="Message ${bot}"]`);
    const send = input?.closest('.agent-composer')?.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]');
    return input?.textContent?.includes(text) === true && send?.disabled === false && !document.querySelector('[data-mention-picker]');
  }, { bot, text });
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

let stack: Stack; let browser: Browser;
beforeAll(async () => {
  stack = await startStack({ teams: true, tools: true,
    // A message that asks for a report in is answered by one turn whose final text is the report; any other input is echoed.
    turns: text => text.includes('Report in with your status.') ? [{ reply: 'Scribe here: ready to keep the notes.' }]
      // A long check keeps the bot's main session busy, waiting for an approval no one gives; a question asked of it is answered by one turn.
      : text.includes('Run the long check.') ? [{ approval: 'Run the check', command: 'npm run check' }]
      : text.includes('What is the build status?') ? [{ reply: 'The build is green.' }] : undefined,
    sessions: {
    chief: { title: 'Chief', history: [{ role: 'user', text: 'Plan the release.' }, { role: 'assistant', text: 'Chief is ready.' }] },
    tracker: { title: 'Tracker', history: [{ role: 'user', text: 'Track the build.' }, { role: 'assistant', text: 'Tracker is ready.' }] },
  } });
  browser = await launchBrowser();
});
afterAll(async () => { await browser?.close(); await stack?.close(); });

const team = (context: BrowserContext) => teamOf(stack, context);
const hasTools = (nativeSessionId: string) => hasToolsOf(stack, nativeSessionId);
const inputs = (nativeSessionId: string) => inputsOf(stack, nativeSessionId);

it('E15: a bot starts two temporary bots; both report while it is idle, as one input, and the page folds them', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await team(context);
  await showsText(page, 'Chief is ready.');
  await hasTools('chief');
  for (const name of ['Logs', 'Tests']) expect(await stack.provider.useTool('chief', 'create_bot', { name, mission: `Collect the ${name.toLowerCase()}.` })).toMatchObject({ status: 'working' });
  const workers = () => stack.provider.known().filter(id => id.includes('-new-'));
  await expect.poll(workers, { timeout: 20_000 }).toHaveLength(2);
  for (const worker of workers()) await hasTools(worker);
  const [logs, tests] = workers();
  await stack.provider.useTool(logs!, 'message', { to: 'chief', text: 'Logs saved in /tmp/logs.', status: 'done' });
  await stack.provider.useTool(tests!, 'message', { to: 'chief', text: 'Two tests fail.', status: 'failed' });
  await expect.poll(() => inputs('chief').map(input => input.kind).sort(), { timeout: 20_000 }).toEqual(['done', 'failed']);
  // Both results reached the chief in one input.
  expect(stack.provider.session('chief')!.sent.filter(text => parseTaskInputs(text))).toHaveLength(1);
  await showsText(page, 'Two tests fail.');
  await context.close();
});

it('E15: a bot messages another bot in its inbox, which answers it, between their turns', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('tracker'));
  await team(context);
  await showsText(page, 'Tracker is ready.');
  await hasTools('chief'); await hasTools('tracker');
  const sent = await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Is the build green?' }) as { messageId: string; outcome: string };
  expect(sent.outcome).toBe('delivered');
  await expect.poll(() => inputs('tracker').filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Chief', body: 'Is the build green?' })]);
  await stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Green.', reply_to: sent.messageId });
  await expect.poll(() => inputs('chief').filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Tracker', body: 'Green.', replyTo: sent.messageId })]);
  // The answer came from the turn the question started, so both are one chain, which the account's audit reads.
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const audit = await (await context.request.get(stack.origin + status.basePath + 'v1/remote/chains')).json() as { chains: Array<{ bots: string[]; messages: number; depth: number }>; names: Record<string, string> };
  const exchange = audit.chains.filter(chain => chain.bots.some(bot => audit.names[bot] === 'Tracker'));
  expect(exchange).toHaveLength(1);
  // Chief asked from the turn its last input started, so the exchange continues that turn's chain.
  expect(exchange[0]!.depth).toBe(2);
  expect(exchange[0]!.messages).toBeGreaterThanOrEqual(2);
  expect(exchange[0]!.bots.map(bot => audit.names[bot])).toEqual(expect.arrayContaining(['Chief', 'Tracker']));
  await context.close();
});

it('E15: a bot hands an item of its board to another bot, which reads the item named, reports on it, and is told when it changes', async () => {
  const { context } = await openPage(browser, stack.sessionUrl('chief'));
  await team(context);
  await hasTools('chief'); await hasTools('tracker');
  const written = await stack.provider.useTool('chief', 'update_board', { items: [{ title: 'Watch the build' }] }) as { items: Array<{ key: number; version: number }> };
  expect(written.items).toEqual([{ key: 1, version: 1 }]);
  // The item is assigned by a board write; the message only names it.
  await stack.provider.useTool('chief', 'update_board', { items: [{ key: 1, version: 1, assignee: 'Tracker', status: 'working', brief: 'Tell me when main is red.' }] });
  expect(await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Tell me when main is red.', item: 1 })).toMatchObject({ outcome: 'delivered' });
  await expect.poll(() => inputs('tracker').filter(input => input.kind === 'assistant').at(-1), { timeout: 20_000 })
    .toMatchObject({ from: 'Chief', body: '[Item 1 "Watch the build" · from Chief]\nTell me when main is red.' });
  await stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Main is green.', status: 'progress', item: 1 });
  await expect.poll(async () => (await stack.provider.useTool('chief', 'board', {}) as { items: Array<{ report?: string; status: string; assignee: string }> }).items[0], { timeout: 20_000 })
    .toMatchObject({ report: 'Main is green.', status: 'working' });
  // The chief retitles it; the one who holds it is told, written from the record.
  await stack.provider.useTool('chief', 'update_board', { items: [{ key: 1, version: 3, title: 'Watch main' }] });
  // The assignment reached it with the message, joined in one input; the retitle came alone.
  await expect.poll(() => stack.provider.session('tracker')!.sent.join('\n'), { timeout: 20_000 }).toContain('[Item "Watch main" changed · retitled to "Watch main"]');
  expect(stack.provider.session('tracker')!.sent.join('\n')).toContain('[Item 1 "Watch the build" changed · assigned to you · brief: Tell me when main is red.]');
  await context.close();
});

it('E15: a bot creates a standing bot, which joins its group in the page and reads its first message', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?mode=bot');
  await team(context);
  await hasTools('chief');
  expect(await stack.provider.useTool('chief', 'create_bot', { name: 'Scribe', mission: 'Keep the release notes.', lifetime: 'standing', message: 'Start from v0.3.' })).toMatchObject({ status: 'ready' });
  await showsText(page, 'Scribe');
  const scribe = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('Keep the release notes.'));
  await expect.poll(scribe, { timeout: 20_000 }).toBeDefined();
  await expect.poll(() => inputs(scribe()!).filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Chief', body: 'Start from v0.3.' })]);
  await context.close();
});

it('E15: a bot answers a message from the final text of its turn, and its chief hears what the person wrote to it', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?mode=bot');
  await team(context);
  await hasTools('chief');
  expect(await stack.provider.useTool('chief', 'create_bot', { name: 'Archivist', mission: 'Keep the changelog.', lifetime: 'standing', message: 'Report in with your status.' })).toMatchObject({ status: 'ready' });
  await showsText(page, 'Archivist');
  const archivist = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('Keep the changelog.'));
  await expect.poll(archivist, { timeout: 20_000 }).toBeDefined();
  // The turn its first message started ended with a text; no tool was called, and the chief reads it as the reply.
  await expect.poll(() => inputs('chief').filter(input => input.kind === 'assistant' && input.from === 'Archivist'), { timeout: 20_000 })
    .toEqual([expect.objectContaining({ from: 'Archivist', body: 'Scribe here: ready to keep the notes.', replyTo: expect.stringMatching(/^m[0-9a-f]{12}$/) })]);
  // The person types into the bot's own session: the chief hears the first words, framed as theirs.
  stack.provider.session(archivist()!)!.write('user', 'Use the short changelog format from now on.');
  await expect.poll(() => inputs('chief').filter(input => input.kind === 'person_wrote'), { timeout: 20_000 })
    .toEqual([{ kind: 'person_wrote', bot: 'Archivist', body: 'Use the short changelog format from now on.' }]);
  await context.close();
});

it('E15: a bot attaches a file to a message and the receiver downloads it, checked against its hash', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?mode=bot');
  await team(context);
  await hasTools('chief'); await hasTools('tracker');
  const bytes = Buffer.from('--- a/notes.md\n+++ b/notes.md\n@@ -1 +1 @@\n-draft\n+final\n');
  const path = join(stack.workspace, 'notes.patch');
  await writeFile(path, bytes);
  expect(await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'The notes patch.', attachments: [{ path: 'notes.patch' }] })).toMatchObject({ outcome: 'delivered' });
  await expect.poll(() => inputs('tracker').filter(input => input.kind === 'assistant' && input.body.includes('notes.patch')), { timeout: 20_000 }).toHaveLength(1);
  const body = (inputs('tracker').filter(input => input.kind === 'assistant').at(-1) as { body: string }).body;
  const id = /(a_[0-9a-f]{32}) · notes\.patch/.exec(body)![1]!;
  const got = await stack.provider.useTool('tracker', 'download_attachment', { attachment: id }) as { path: string; sha256: string; verified: boolean };
  expect(got).toMatchObject({ sha256: createHash('sha256').update(bytes).digest('hex'), verified: true });
  expect(await readFile(got.path)).toEqual(bytes);
  await context.close();
});

it('E15: the person stops a chain from the audit in Settings, and a bot\'s next call in it is refused', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?page=settings&group=assistants');
  await team(context);
  await hasTools('chief'); await hasTools('tracker');
  const sent = await stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Draft the notes.' }) as { messageId: string };
  await expect.poll(() => inputs('tracker').some(input => input.kind === 'assistant' && input.body === 'Draft the notes.'), { timeout: 20_000 }).toBe(true);
  // The new group opened in the page; the person goes to Settings > Assistants.
  await page.goto(stack.origin + '/?page=settings&group=assistants');
  // The newest chain is the one this message continued; it lists Tracker among its bots.
  const row = page.locator('.lab-bot-audit > ul > li').first();
  await row.locator('.lab-assistant-session-toggle').click();
  await expect.poll(() => row.innerText(), { timeout: 20_000 }).toContain('Tracker');
  await row.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(() => row.locator('small').innerText(), { timeout: 20_000 }).toContain('Stopped');
  // The refusal is an outcome the bot reads, with the reason.
  await expect(stack.provider.useTool('tracker', 'message', { to: 'Chief', text: 'Notes drafted.', reply_to: sent.messageId })).resolves.toMatchObject({ outcome: 'forbidden', reason: expect.stringContaining('The person stopped this work') });
  await context.close();
});

it('E15: the person mentions a busy bot from another conversation, and the answer shows in place while the bot\'s main turn runs and nothing reaches either session', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await team(context);
  // Earlier cases filled Chief's conversation, so its first turns are folded away and a turn out of view is not in the page's text:
  // the page is ready when both conversations hold turns.
  await page.locator('[data-testid="prompt-input"][data-placeholder^="Message Tracker"]').waitFor();
  await waitForEntries(page, 2);
  await hasTools('chief'); await hasTools('tracker');
  // Tracker's main session starts a turn that does not end.
  await page.locator('[data-testid="prompt-input"][data-placeholder^="Message Tracker"]').click();
  await page.keyboard.type('Run the long check.');
  await holdsComposerText(page, 'Tracker', 'Run the long check.');
  await page.keyboard.press('Enter');
  await expect.poll(() => stack.provider.session('tracker')!.sent.includes('Run the long check.'), { timeout: 20_000 }).toBe(true);
  const trackerInputs = stack.provider.session('tracker')!.sent.length, chiefInputs = stack.provider.session('chief')!.sent.length;
  // The person asks it from the Chief conversation, the page's composer being the way to mention a bot.
  const composer = page.locator('[data-testid="prompt-input"][data-placeholder^="Message Chief"]');
  await composer.click();
  await page.keyboard.type('@Tracker What is the build status?');
  await holdsComposerText(page, 'Chief', '@Tracker What is the build status?');
  await page.keyboard.press('Enter');
  await showsText(page, 'Tracker answered');
  await page.locator('summary', { hasText: 'Tracker answered' }).click();
  await holdsText(page, 'The build is green.');
  await holdsText(page, 'What is the build status?');
  // The answer came from a session of its own, started with the bot's mission and the framed question.
  const answering = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('answer session'));
  await expect.poll(answering, { timeout: 20_000 }).toBeDefined();
  expect(inputs(answering()!)).toEqual([{ kind: 'ask', from: 'Chief', body: 'What is the build status?' }]);
  // Neither the conversation it was asked from nor the bot's busy main session received anything.
  expect(stack.provider.session('chief')!.sent).toHaveLength(chiefInputs);
  expect(stack.provider.session('tracker')!.sent).toHaveLength(trackerInputs);
  // The mention is a chain of the person's that names the bot and counts the answer's turn.
  const status = await (await context.request.get(stack.origin + '/auth/status')).json() as { basePath: string };
  const audit = await (await context.request.get(stack.origin + status.basePath + 'v1/remote/chains')).json() as { chains: Array<{ cause: string; bots: string[]; turns: number }>; names: Record<string, string> };
  expect(audit.chains.filter(chain => chain.cause === 'person' && chain.bots.some(bot => audit.names[bot] === 'Tracker') && chain.turns === 1)).toHaveLength(1);
  await context.close();
});
