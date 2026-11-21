import { afterEach, expect, it } from 'vitest';

import { HOST_ID, PUBLIC_ID, seedJournal, startRelay, type Wire } from './test-utils/journal-session-fixture.js';

/**
 * A session whose CLI refuses the Controller for its own reason (O48): another process writes it. A session the Relay reads from its
 * journal stays readable: its attach is answered with the binding, its pages are told the reason in their control state, and a page's
 * request for control asks the Controller again.
 */
const started: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => { for (const relay of started.splice(0)) await relay.dispose(); });

const refusal = { status: 409, body: { code: 'session_in_use', error: 'thread already has an active writer', reason: 'writer_elsewhere', retryAfterMs: 5000 } };
async function relay(options: { journal?: boolean } = {}) {
  const value = await startRelay(options.journal === false ? {} : { seed: seedJournal });
  started.push(value);
  return value;
}
const attach = (r: Awaited<ReturnType<typeof relay>>) => r.broker.handleRequest(new Request(`https://relay.example/v1/remote/hosts/${HOST_ID}/attach`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://relay.example' }, body: JSON.stringify({ providerId: 'codex', nativeSessionId: 'native-session' }) }));

it("answers the attach of a journal-served session with its binding while the CLI refuses the Controller, and tells its page why", async () => {
  const r = await relay();
  const behavior: { attach?: { status: number; body: unknown } } = { attach: refusal };
  await r.connectController(behavior);
  const opened = await attach(r);
  expect(opened!.status).toBe(200);
  expect(await opened!.json()).toMatchObject({ agentId: PUBLIC_ID, nativeSessionId: 'native-session' });
  const page = await r.openBrowser();
  page.send({ type: 'negotiate' });
  const announced = await page.take((frame: Wire) => frame.type === 'session_control', 'the control state');
  expect(announced.payload).toEqual({ agentId: PUBLIC_ID, revision: expect.any(String), access: 'read_only', available: false, nativeRefusal: { reason: 'writer_elsewhere', retryAfterMs: 5000 } });
});

it("asks the Controller again when the page asks for control, and gives control once the CLI takes it", async () => {
  const r = await relay();
  const behavior: { attach?: { status: number; body: unknown } } = { attach: refusal };
  const controller = await r.connectController(behavior);
  await attach(r);
  const page = await r.openBrowser();
  page.send({ type: 'negotiate' });
  const announced = await page.take((frame: Wire) => frame.type === 'session_control', 'the control state');
  const asked = controller.attaches.length;
  delete behavior.attach;
  page.send({ type: 'session_control_request', payload: { agentId: PUBLIC_ID, requestId: 'retry', revision: announced.payload.revision, action: 'acquire' } });
  expect((await page.take((frame: Wire) => frame.type === 'session_control' && frame.payload.requestId === 'retry', 'the answer')).payload).toMatchObject({ access: 'read_only', nativeRefusal: { reason: 'writer_elsewhere' } });
  const granted = await page.take((frame: Wire) => frame.type === 'session_control' && frame.payload.access === 'control', 'control once the CLI takes the Controller');
  expect(granted.payload).toEqual({ agentId: PUBLIC_ID, revision: announced.payload.revision, access: 'control', available: true, token: expect.any(String) });
  expect(controller.attaches.length).toBe(asked + 1);
});

it('refuses the attach of a session it cannot read without the Controller, with the reason and no owner', async () => {
  const r = await relay({ journal: false });
  await r.connectController({ attach: refusal });
  const refused = await attach(r);
  expect(refused!.status).toBe(409);
  const body = await refused!.json();
  expect(body).toMatchObject({ code: 'session_in_use', error: expect.stringMatching(/active writer/) });
  expect(body).not.toHaveProperty('nativeOwner');
});
