// E15, bots that call bots (bots design 11): the real page, Relay and Controller, with scripted sessions that take tools. A flow calls a
// bot's tool in its model's place (`useTool`); everything the call causes runs for real: tasks and their workers, inboxes, framed inputs,
// delivery between turns, and a standing bot joining its chief's group.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { parseTaskInputs } from '@orchardworks/agent-remote-protocol';
import { startStack, type Stack } from '@orchardworks/agent-e2e/stack';
import { hasTools as hasToolsOf, inputs as inputsOf, team as teamOf } from './bot-team.js';
import { launchBrowser, openPage } from './browser.js';
import { holdsText, pairSecondHost, showsText, waitForEntries } from './page.js';

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
    // A message that asks for a report in starts one turn that ends with a text; any other input is echoed.
    turns: text => text.includes('Report in with your status.') ? [{ reply: 'Scribe here: ready to keep the notes.' }]
      // A sub-session's turn ends with a result: the text of its last words.
      : text.includes('Collect the logs.') ? [{ reply: 'Logs saved in /tmp/logs.' }] : text.includes('Collect the tests.') ? [{ reply: 'Two tests fail.' }]
      : text.includes('Compress them.') ? [{ reply: 'Compressed into logs.tgz.' }]
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

it('E15: a bot starts two sub-sessions; both report while it is idle, and the page shows their results as cards', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('chief'));
  await team(context);
  await showsText(page, 'Chief is ready.');
  await hasTools('chief');
  const started = [];
  for (const name of ['Logs', 'Tests']) started.push(await stack.provider.useTool('chief', 'create_sub_session', { name, prompt: `Collect the ${name.toLowerCase()}.` }));
  expect(started).toEqual([expect.objectContaining({ status: 'working', sub_session_id: expect.stringMatching(/^s_[0-9a-f]{32}$/) }), expect.objectContaining({ status: 'working' })]);
  const workers = () => stack.provider.known().filter(id => id.includes('-new-'));
  await expect.poll(workers, { timeout: 20_000 }).toHaveLength(2);
  // A sub-session is no bot: it has its few tools, and another bot cannot list it.
  for (const worker of workers()) await expect.poll(() => stack.provider.given(worker)?.tools.map(tool => tool.name).sort(), { timeout: 20_000 }).toEqual(['board', 'communicate_update', 'read_main_session', 'update_board']);
  const listed = await stack.provider.useTool('chief', 'list_bots', {}) as { bots: Array<{ name: string }> };
  expect(listed.bots.map(bot => bot.name)).not.toContain('Logs');
  // Each turn ended with its result, which reached the chief as input.
  await expect.poll(() => inputs('chief').map(input => input.kind).sort(), { timeout: 20_000 }).toEqual(['done', 'done']);
  await showsText(page, 'Logs saved in /tmp/logs.');
  await showsText(page, 'Two tests fail.');
  await context.close();
});

it('E15: a bot gives the same sub-session more work, reads its status and stops it', async () => {
  const { context, page } = await openPage(browser, stack.sessionUrl('tracker'));
  await team(context);
  await showsText(page, 'Tracker is ready.');
  await hasTools('tracker');
  const created = await stack.provider.useTool('tracker', 'create_sub_session', { name: 'Collector', prompt: 'Collect the logs.' }) as { sub_session_id: string };
  const worker = () => stack.provider.known().filter(id => id.includes('-new-')).at(-1)!;
  const results = () => inputs('tracker').map(input => input.kind).filter(kind => kind === 'done');
  await expect.poll(results, { timeout: 20_000 }).toEqual(['done']);
  const sessionsBefore = stack.provider.known().length;
  // More related work goes to the same session: no new session starts, and its next result arrives.
  expect(await stack.provider.useTool('tracker', 'send_to_sub_session', { sub_session_id: created.sub_session_id, message: 'Compress them.', title: 'Compress' })).toMatchObject({ delivered_as: expect.stringMatching(/delivered|held/) });
  await expect.poll(results, { timeout: 20_000 }).toEqual(['done', 'done']);
  expect(stack.provider.known()).toHaveLength(sessionsBefore);
  const status = await stack.provider.useTool('tracker', 'get_sub_session_status', {}) as { sub_sessions: Array<Record<string, unknown>> };
  expect(status.sub_sessions).toEqual([expect.objectContaining({ name: 'Collector', lifecycle: 'live', turn_in_flight: false, last_terminal_turn_status: 'finished', last_work_title: 'Compress', last_result: 'Compressed into logs.tgz.' })]);
  expect(stack.provider.session(worker())).toBeDefined();
  // It ends when its bot stops it; more work is then unreachable.
  await stack.provider.useTool('tracker', 'stop_sub_session', { sub_session_id: created.sub_session_id });
  expect(await stack.provider.useTool('tracker', 'send_to_sub_session', { sub_session_id: created.sub_session_id, message: 'More.', title: 'More' })).toMatchObject({ delivered_as: 'unreachable' });
  expect((await stack.provider.useTool('tracker', 'get_sub_session_status', {}) as { sub_sessions: unknown[] }).sub_sessions).toEqual([]);
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
  expect(await stack.provider.useTool('chief', 'create_bot', { name: 'Scribe', mission: 'Keep the release notes.', message: 'Start from v0.3.' })).toMatchObject({ status: 'ready' });
  await showsText(page, 'Scribe');
  const scribe = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('Keep the release notes.'));
  await expect.poll(scribe, { timeout: 20_000 }).toBeDefined();
  await expect.poll(() => inputs(scribe()!).filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toEqual([expect.objectContaining({ from: 'Chief', body: 'Start from v0.3.' })]);
  await context.close();
});

it('E15: a bot with the tools answers a message with message, not its final text, and its chief hears what the person wrote to it', async () => {
  const { context, page } = await openPage(browser, stack.origin + '/?mode=bot');
  await team(context);
  await hasTools('chief');
  expect(await stack.provider.useTool('chief', 'create_bot', { name: 'Archivist', mission: 'Keep the changelog.', message: 'Report in with your status.' })).toMatchObject({ status: 'ready' });
  await showsText(page, 'Archivist');
  const archivist = () => stack.provider.known().filter(id => id.includes('-new-')).find(id => stack.provider.given(id)?.instructions?.includes('Keep the changelog.'));
  await expect.poll(archivist, { timeout: 20_000 }).toBeDefined();
  // The turn its first message started ended with a text, which goes to no one: a bot with the tools answers with message.
  await expect.poll(() => inputs(archivist()!).filter(input => input.kind === 'assistant'), { timeout: 20_000 }).toHaveLength(1);
  const asked = (inputs(archivist()!).find(input => input.kind === 'assistant') as { messageId?: string }).messageId;
  expect(inputs('chief').filter(input => input.kind === 'assistant' && input.from === 'Archivist')).toEqual([]);
  expect(await stack.provider.useTool(archivist()!, 'message', { to: 'chief', text: 'Scribe here: ready to keep the notes.', reply_to: asked })).toMatchObject({ outcome: 'delivered' });
  await expect.poll(() => inputs('chief').filter(input => input.kind === 'assistant' && input.from === 'Archivist'), { timeout: 20_000 })
    .toEqual([expect.objectContaining({ from: 'Archivist', body: 'Scribe here: ready to keep the notes.', replyTo: asked })]);
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

it('E15: a chief lists the Hosts, starts a sub-session in a new folder of another Host, and the item records where it works', async () => {
  const studio = await pairSecondHost(stack, { name: 'Studio', installationId: 'e2e-e15-studio', teams: true, workspaces: true, tools: true, sessions: {} });
  try {
    const { context } = await openPage(browser, stack.sessionUrl('chief'));
    await team(context);
    await hasTools('chief');
    const listed = await stack.provider.useTool('chief', 'list_hosts', {}) as { hosts: Array<{ id: string; name: string; online: boolean; providers: string[]; workspaces?: Array<{ path: string; folders: string[] }> }> };
    expect(listed.hosts.map(host => host.name).sort()).toEqual([stack.hostName, 'Studio']);
    expect(listed.hosts.find(host => host.id === studio.hostId)).toMatchObject({ name: 'Studio', online: true, providers: [studio.provider.providerId], workspaces: [{ path: studio.workspace }] });
    // The chief puts the work on its board, then starts the sub-session for that item in a new folder of the other Host.
    const written = await stack.provider.useTool('chief', 'update_board', { items: [{ title: 'Build the shop API', brief: 'Build the shop API.' }] }) as { items: Array<{ key: number }> };
    const folder = join(studio.workspace!, 'shop-api');
    const created = await stack.provider.useTool('chief', 'create_sub_session', { name: 'Shop', prompt: 'Build the shop API.', host: studio.hostId, new_folder: { name: 'shop-api' }, tracked_task_keys: [written.items[0]!.key] });
    expect(created).toMatchObject({ status: 'working', host: 'Studio', folder });
    expect(existsSync(folder)).toBe(true);
    const workers = () => studio.provider.known().filter(id => id.includes('-new-'));
    await expect.poll(workers, { timeout: 20_000 }).toHaveLength(1);
    expect(studio.provider.startedIn(workers()[0]!)).toBe(folder);
    expect(stack.provider.known().filter(id => id.includes('-new-')).every(id => stack.provider.startedIn(id) !== folder)).toBe(true);
    await expect.poll(() => studio.provider.given(workers()[0]!)?.tools.map(tool => tool.name) ?? [], { timeout: 20_000 }).toContain('communicate_update');
    const board = await stack.provider.useTool('chief', 'board', {}) as { items: Array<{ links: unknown[] }> };
    expect(board.items.at(-1)!.links).toEqual([{ kind: 'host', value: 'Studio' }, { kind: 'folder', value: folder }, { kind: 'sub_session', value: (created as { sub_session_id: string }).sub_session_id }]);
    // A folder that already exists is refused as the outcome, and no second bot starts.
    await expect(stack.provider.useTool('chief', 'create_sub_session', { name: 'Again', prompt: 'Build it again.', host: studio.hostId, new_folder: { name: 'shop-api' } })).rejects.toThrow('already exists');
    expect(workers()).toHaveLength(1);
    await context.close();
  } finally { await studio.close(); }
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
  // The bot's main session learns what its answer session did without replaying the chat: the next input it is given carries the work log.
  // Its busy turn ends when the person allows the check; then Chief's message reaches it with the log line in front.
  // Chief starts a new chain with an input of the person's (an earlier flow stopped the one it was in).
  await composer.click();
  await page.keyboard.type('Check the build with Tracker.');
  await holdsComposerText(page, 'Chief', 'Check the build with Tracker.');
  await page.keyboard.press('Enter');
  await expect.poll(() => stack.provider.session('chief')!.sent.includes('Check the build with Tracker.'), { timeout: 20_000 }).toBe(true);
  await expect(stack.provider.useTool('chief', 'message', { to: 'Tracker', text: 'Where does the build stand?', operationId: 'log-1' })).resolves.toMatchObject({ outcome: expect.stringMatching(/delivered|held/) });
  const allow = page.locator('.agent-tool-approval').getByRole('button', { name: 'Allow', exact: true });
  for (let attempt = 0; attempt < 5 && await allow.count(); attempt++) { await allow.click(); await page.waitForTimeout(1500); }
  await expect.poll(() => inputs('tracker').find(input => input.kind === 'work_log'), { timeout: 30_000 }).toMatchObject({ count: 1, body: expect.stringContaining('What is the build status? → The build is green.') });
  const received = inputs('tracker'), at = received.findIndex(input => input.kind === 'work_log');
  expect(received.slice(at + 1).find(input => input.kind === 'assistant')).toMatchObject({ body: expect.stringContaining('Where does the build stand?') });
  await showsText(page, 'Work log: 1 new entry');
  await context.close();
}, 90_000);
