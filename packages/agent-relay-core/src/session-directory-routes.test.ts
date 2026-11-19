import { describe, expect, it } from 'vitest';

import { createSessionDirectoryRoutes } from './session-directory-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const referencing = [{ providerId: 'codex', displayName: 'Codex', sessionReferences: true as const }];
const setup = () => {
  const run = routeFixture({ providers: referencing });
  const route = createSessionDirectoryRoutes({ access: run.access, brokerState: run.state, rpc: run.rpc, waitForCreation: async () => { throw new Error('unused'); },
    userMutation: (() => { throw new Error('unused'); }) as never, sharedCatalog: async () => ({ status: 200, body: '{}' }) });
  return { ...run, route };
};

describe('session references', () => {
  const edit = (target: string, action = 'add') => ({ providerId: 'codex', nativeSessionId: 'mine', action, target: { providerId: 'codex', nativeSessionId: target } });

  it('lets a guest add a reference only to a session it may open, and asks the Controller for nothing else', async () => {
    const run = setup();
    run.bind('a-mine', 'mine', 'guest'); run.bind('a-theirs', 'theirs', 'owner');
    await expect(run.call(run.route, 'POST', '/v1/remote/hosts/h1/session/refs', edit('theirs'), 'guest')).rejects.toMatchObject({ status: 403, code: 'session_forbidden' });
    expect(run.calls).toEqual([]);
    await run.call(run.route, 'POST', '/v1/remote/hosts/h1/session/refs', edit('mine'), 'guest');
    expect(run.calls).toHaveLength(1);
  });

  it('lets a guest remove a reference to a session it cannot open, and the owner add any', async () => {
    const run = setup();
    run.bind('a-mine', 'mine', 'guest'); run.bind('a-theirs', 'theirs', 'owner');
    await run.call(run.route, 'POST', '/v1/remote/hosts/h1/session/refs', edit('theirs', 'remove'), 'guest');
    await run.call(run.route, 'POST', '/v1/remote/hosts/h1/session/refs', { ...edit('theirs'), nativeSessionId: 'theirs' }, 'owner');
    expect(run.calls.map(call => JSON.parse(call.body!).action)).toEqual(['remove', 'add']);
  });

  it('refuses a guest the references of a session it did not create', async () => {
    const run = setup();
    run.bind('a-theirs', 'theirs', 'owner');
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/session/refs?providerId=codex&nativeSessionId=theirs', undefined, 'guest')).rejects.toMatchObject({ status: 403 });
    expect(run.calls).toEqual([]);
  });
});
