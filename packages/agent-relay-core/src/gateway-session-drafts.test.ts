import { expect, it } from 'vitest';

import { fixture as start, until } from './test-utils/relay-harness.js';

const ref = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };
const SNAPSHOT = { protocolVersion: '1.8.0', type: 'session_drafts', snapshot: true };

it('keeps drafts per account and shares them with every page that asks for them', async () => {
  const h = await start(); const alice = await h.login('alice'); const phone = await h.login('alice'); const bob = await h.login('bob');
  const desk = await h.listen(alice, 'observation=activity&drafts=1'), other = await h.listen(phone, 'observation=activity&drafts=1');
  const stranger = await h.listen(bob, 'observation=activity&drafts=1'), plain = await h.listen(alice, 'observation=activity');
  await until(() => desk.of('session_drafts')[0], 'the first snapshot');
  expect(desk.of('session_drafts')[0]).toEqual({ ...SNAPSHOT, drafts: [] });
  const save = (account: typeof alice, body: unknown) => h.json(account.basePath + 'v1/session-drafts', account.cookie, body as object);
  const saved = await (await save(alice, { ...ref, text: 'Ship the release notes' })).json() as { revision: number };
  expect(saved).toEqual({ ...ref, text: 'Ship the release notes', revision: expect.any(Number) });
  await until(() => other.of('session_drafts').at(-1)?.drafts[0]?.text === 'Ship the release notes', 'the draft on the other page');
  expect(other.of('session_drafts').at(-1).drafts).toEqual([saved]);
  // A cleared draft reaches every page too, and a page that connects later starts from it.
  const cleared = await (await save(alice, { ...ref, text: '' })).json() as { revision: number };
  expect(cleared.revision).toBeGreaterThan(saved.revision);
  await until(() => other.of('session_drafts').at(-1)?.drafts[0]?.text === '', 'the cleared draft');
  const late = await h.listen(phone, 'observation=activity&drafts=1');
  await until(() => late.of('session_drafts')[0], 'the late snapshot');
  expect(late.of('session_drafts')[0]).toEqual({ ...SNAPSHOT, drafts: [{ ...ref, text: '', revision: cleared.revision }] });
  expect(await (await h.json(alice.basePath + 'v1/session-drafts', alice.cookie)).json()).toEqual({ drafts: [{ ...ref, text: '', revision: cleared.revision }] });
  expect((await save(alice, { ...ref, text: 'x'.repeat(8193) })).status).toBe(400);
  expect(stranger.of('session_drafts')).toEqual([{ ...SNAPSHOT, drafts: [] }]);
  expect(plain.messages.some(message => message.type === 'session_drafts')).toBe(false);
});

it('keeps drafts across a restart of the Relay', async () => {
  const h = await start(); const alice = await h.login('alice');
  await h.json(alice.basePath + 'v1/session-drafts', alice.cookie, { ...ref, text: 'After the restart' });
  await h.restart();
  const again = await h.login('alice');
  const after = await h.listen(again, 'observation=activity&drafts=1');
  await until(() => after.of('session_drafts')[0], 'the snapshot after the restart');
  expect(after.of('session_drafts')[0].drafts).toEqual([{ ...ref, text: 'After the restart', revision: expect.any(Number) }]);
});

it('saves drafts on a budget of their own, leaving control requests theirs', async () => {
  const h = await start(); const alice = await h.login('alice');
  for (let index = 0; index < 70; index++) expect((await h.json(alice.basePath + 'v1/session-drafts', alice.cookie, { ...ref, text: `Draft ${index}` })).status).toBe(200);
  // Control requests still pass the limiter (this one is refused for its input, not its rate).
  expect((await h.json(alice.basePath + 'v1/session-relations/reset', alice.cookie, {})).status).not.toBe(429);
});
