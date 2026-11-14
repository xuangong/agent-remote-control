import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
import { setPromptText } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

async function openBot(app: Awaited<ReturnType<typeof mountBotApp>>) {
  await until(() => expect(app.workspace().window?.id).toBe('A'));
  await app.switchMode('bot');
  await act(async () => app.button('A1').click());
  await until(() => expect(app.container.querySelector('.lab-bot-conversation [role="textbox"]')).not.toBeNull());
}

it("sends to a bot whose Host is offline: the message waits in the outbox on every page until it is cancelled", async () => {
  const scope = 'http://localhost/u/bot-outbox/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, host: { online: false, outbox: 1 } });
  const input = () => app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  const submit = () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!;
  const bubbles = () => [...app.container.querySelectorAll<HTMLElement>('.lab-bot-conversation .lab-outbox-message')];
  try {
    await openBot(app);
    await act(async () => app.emitOutbox({ snapshot: true }));
    await act(async () => { setPromptText(input(), 'Run the suite when you are back.'); input().dispatchEvent(new Event('input', { bubbles: true })); });
    await until(() => expect(submit().getAttribute('aria-label')).toBe('Send when Test Host is back'));
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    await until(() => expect(app.queued).toEqual([{ id: expect.any(String), nativeSessionId: 'A1', text: 'Run the suite when you are back.' }]));
    await until(() => expect(input().textContent).toBe(''));
    // It shows after the conversation as an outgoing message that has not gone out yet.
    await until(() => expect(bubbles()).toHaveLength(1));
    expect(bubbles()[0]!.textContent).toContain('Run the suite when you are back.');
    expect(bubbles()[0]!.querySelector('.agent-message-delivery')!.textContent).toBe('Waiting for Test Host');
    // Another device cancels it: it leaves this page too.
    await act(async () => app.emitOutbox({ removed: [app.queued[0]!.id] }));
    await until(() => expect(bubbles()).toHaveLength(0));
    // And here, Cancel takes it back.
    await act(async () => { setPromptText(input(), 'Never mind.'); input().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => submit().click());
    await until(() => expect(bubbles()).toHaveLength(1));
    await act(async () => bubbles()[0]!.querySelector<HTMLButtonElement>('[aria-label="Cancel message"]')!.click());
    await until(() => expect(app.cancelled).toEqual([app.queued[1]!.id]));
    await until(() => expect(bubbles()).toHaveLength(0));
  } finally { await app.close(); }
});

it('says to update the Controller of an offline Host that cannot keep messages', async () => {
  const scope = 'http://localhost/u/bot-outbox-old/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, host: { online: false } });
  try {
    await openBot(app);
    await until(() => expect(app.container.querySelector('.lab-bot-conversation')!.textContent).toContain('Update the Controller on Test Host to send while it is offline.'));
    expect(app.container.querySelector('.lab-bot-conversation [data-testid="prompt-submit"]')!.getAttribute('aria-label')).toBe('Send message');
  } finally { await app.close(); }
});

it("notices at once that a bot's Host left, from the shared states channel, without waiting for the Host list", async () => {
  const scope = 'http://localhost/u/bot-host-left/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, host: { outbox: 1 } });
  const input = () => app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  const submit = () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!;
  try {
    await openBot(app);
    await act(async () => app.emitStates({ snapshot: true, hosts: [{ hostId: 'local', online: true }], states: [] }));
    await act(async () => { setPromptText(input(), 'Run it later.'); input().dispatchEvent(new Event('input', { bubbles: true })); });
    await until(() => expect(submit().getAttribute('aria-label')).not.toBe('Send when Test Host is back'));
    // The Host's computer sleeps: the Relay says so on the states channel at once; the Host list agrees when asked.
    app.setHostOnline(false);
    await act(async () => app.emitStates({ hosts: [{ hostId: 'local', online: false }] }));
    await until(() => expect(submit().getAttribute('aria-label')).toBe('Send when Test Host is back'));
  } finally { await app.close(); }
});

it('does not ask an offline Host for a bot it holds, and opens the conversation once the Host is back', async () => {
  const scope = 'http://localhost/u/bot-host-away/';
  // B is not the Window shown in Window mode, so nothing opens its bots before the test does.
  seedGroup(scope, botGroup('A')); seedGroup(scope, botGroup('B')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true, host: { outbox: 1 } });
  const submit = () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!;
  try {
    await openBot(app);
    await act(async () => app.emitStates({ snapshot: true, hosts: [{ hostId: 'local', online: true }], states: [] }));
    // The Host leaves while the page runs: the page learns it, then a bot not opened yet is opened.
    app.setHostOnline(false);
    await act(async () => app.emitStates({ hosts: [{ hostId: 'local', online: false }] }));
    await until(() => expect(submit().getAttribute('aria-label')).toBe('Send when Test Host is back'));
    await act(async () => app.button('B1').click());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(app.attachments).not.toContain('B1');
    app.setHostOnline(true);
    await act(async () => app.emitStates({ hosts: [{ hostId: 'local', online: true }] }));
    await until(() => expect(app.attachments).toContain('B1'));
  } finally { await app.close(); }
});
