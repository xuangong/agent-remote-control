import { describe, expect, it } from 'vitest';

import { createHostServiceRoutes } from './host-service-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const setup = () => {
  const run = routeFixture();
  return { ...run, route: createHostServiceRoutes({ access: run.access, brokerState: run.state, rpc: run.rpc }) };
};

describe('the VS Code tunnel of a Host', () => {
  it('is the owner\'s: a guest of the Host is refused before the Controller is asked', async () => {
    const run = setup();
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/vscode-tunnel', undefined, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    await expect(run.call(run.route, 'POST', '/v1/remote/hosts/h1/vscode-tunnel/start', { acceptLicense: true }, 'guest')).rejects.toMatchObject({ status: 403 });
    expect(run.calls).toEqual([]);
  });

  it('reads with GET and starts or stops with POST only, and asks the Controller for nothing otherwise', async () => {
    const run = setup();
    await expect(run.call(run.route, 'POST', '/v1/remote/hosts/h1/vscode-tunnel', {})).resolves.toMatchObject({ status: 405 });
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/vscode-tunnel/stop')).resolves.toMatchObject({ status: 405 });
    await expect(run.call(run.route, 'DELETE', '/v1/remote/hosts/h1/vscode-tunnel')).resolves.toMatchObject({ status: 405 });
    expect(run.calls).toEqual([]);
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/vscode-tunnel')).resolves.toMatchObject({ status: 200 });
    await expect(run.call(run.route, 'POST', '/v1/remote/hosts/h1/vscode-tunnel/stop', {})).resolves.toMatchObject({ status: 200 });
    expect(run.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /remote/vscode-tunnel', 'POST /remote/vscode-tunnel/stop']);
  });

  it('starts only after the license terms are accepted', async () => {
    const run = setup();
    await expect(run.call(run.route, 'POST', '/v1/remote/hosts/h1/vscode-tunnel/start', {})).resolves.toMatchObject({ status: 400 });
    expect(run.calls).toEqual([]);
  });

  it('withholds the Controller\'s answer when the connection no longer belongs to the owner', async () => {
    const run = setup();
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/vscode-tunnel', undefined, 'owner', 'guest')).rejects.toMatchObject({ status: 403 });
    expect(run.calls).toHaveLength(1);
  });

  it('withholds the Controller\'s answer when the Host was removed while it answered', async () => {
    const run = setup();
    run.answerWith(() => { run.state.hosts.delete('h1'); return { status: 200, body: '{}' }; });
    await expect(run.call(run.route, 'GET', '/v1/remote/hosts/h1/vscode-tunnel')).rejects.toMatchObject({ status: 404, code: 'host_not_found' });
  });
});
