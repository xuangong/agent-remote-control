import { describe, expect, it } from 'vitest';

import { createControllerRoutes } from './controller-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const setup = () => {
  const run = routeFixture();
  const looked: unknown[] = [], actions: string[] = [];
  const route = createControllerRoutes({ access: run.access, brokerState: run.state, rpc: run.rpc,
    options: { controllerReleases: { latest: async () => { looked.push('latest'); return undefined as never; } } as never },
    successionAction: (async (_host: unknown, action: string) => { actions.push(action); return {}; }) as never });
  return { ...run, route, looked, actions };
};

describe('Controller routes are the owner\'s', () => {
  it('shows the Controller release lookup to the owner and refuses a guest without looking it up', async () => {
    const run = setup();
    await expect(run.call(run.route, 'GET', '/v1/remote/controller-release', undefined, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    expect(run.looked).toEqual([]);
    await expect(run.call(run.route, 'GET', '/v1/remote/controller-release', undefined, 'owner')).resolves.toMatchObject({ status: 200 });
    expect(run.looked).toEqual(['latest']);
  });

  it('refuses a guest every succession action, the Controller update and the provider settings of a Host it shares', async () => {
    const run = setup();
    for (const [method, path] of [['POST', '/v1/remote/hosts/h1/succession/prepare'], ['GET', '/v1/remote/hosts/h1/controller-update'], ['GET', '/v1/remote/hosts/h1/provider-settings']]) {
      await expect(run.call(run.route, method!, path!, method === 'POST' ? {} : undefined, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    }
    expect(run.actions).toEqual([]);
    expect(run.calls).toEqual([]);
  });

  it('withholds the provider settings the Controller answered when the connection no longer belongs to the owner', async () => {
    const run = setup();
    run.host.providerManagement = true;
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/provider-settings', undefined, 'owner', 'guest')).rejects.toMatchObject({ status: 403 });
    expect(run.calls).toHaveLength(1);
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/provider-settings', undefined, 'owner', 'owner')).resolves.toMatchObject({ status: 200 });
  });

  it('withholds the provider settings the Controller answered when the Host was removed while it answered', async () => {
    const run = setup();
    run.host.providerManagement = true;
    run.answerWith(() => { run.state.hosts.delete('h1'); return { status: 200, body: '{}' }; });
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/provider-settings')).rejects.toMatchObject({ status: 404, code: 'host_not_found' });
  });
});
