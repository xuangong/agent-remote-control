import { expect, it } from 'vitest';
import { fixture, origin } from './fixture.js';

it('keeps drafts per account and shares them with every page that asks for them', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const phone = await f.login('alice'); const bob = await f.login('bob');
  const listen = async (account: typeof alice, query = 'observation=activity&drafts=1') => {
    const messages: any[] = [];
    const socket = await f.upgrade(account.basePath + `v1/session-channel?${query}`, { cookie: account.cookie, origin });
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))));
    return { socket, messages, drafts: () => messages.filter(message => message.type === 'session_drafts') };
  };
  const desk = await listen(alice), other = await listen(phone), stranger = await listen(bob), plain = await listen(alice, 'observation=activity');
  await expect.poll(() => desk.drafts()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_drafts', snapshot: true, drafts: [] });
  const save = (account: typeof alice, body: unknown) => f.json(account.basePath + 'v1/session-drafts', account.cookie, body as object);
  const ref = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
  const saved = await (await save(alice, { ...ref, text: 'Ship the release notes' })).json() as { revision: number };
  expect(saved).toEqual({ ...ref, text: 'Ship the release notes', revision: expect.any(Number) });
  await expect.poll(() => other.drafts().at(-1)?.drafts).toEqual([saved]);
  // A cleared draft reaches every page too, and a page that connects later starts from it.
  const cleared = await (await save(alice, { ...ref, text: '' })).json() as { revision: number };
  expect(cleared.revision).toBeGreaterThan(saved.revision);
  await expect.poll(() => other.drafts().at(-1)?.drafts).toEqual([{ ...ref, text: '', revision: cleared.revision }]);
  const late = await listen(phone);
  await expect.poll(() => late.drafts()[0]).toEqual({ protocolVersion: '1.8.0', type: 'session_drafts', snapshot: true, drafts: [{ ...ref, text: '', revision: cleared.revision }] });
  expect(await (await f.json(alice.basePath + 'v1/session-drafts', alice.cookie)).json()).toEqual({ drafts: [{ ...ref, text: '', revision: cleared.revision }] });
  expect((await save(alice, { ...ref, text: 'x'.repeat(8193) })).status).toBe(400);
  expect(stranger.drafts()).toEqual([{ protocolVersion: '1.8.0', type: 'session_drafts', snapshot: true, drafts: [] }]);
  expect(plain.messages.some(message => message.type === 'session_drafts')).toBe(false);
  // Drafts outlive a restart of the Relay.
  await save(alice, { ...ref, text: 'After the restart' });
  await f.restart();
  const again = await f.login('alice');
  const after = await listen(again);
  await expect.poll(() => after.drafts()[0]?.drafts).toEqual([{ ...ref, text: 'After the restart', revision: expect.any(Number) }]);
}, 20000);
