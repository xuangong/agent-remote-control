import { describe, expect, it } from 'vitest';

import { createSessionReadRoutes } from './session-read-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const setup = () => {
  const run = routeFixture();
  const binding = run.bind('a1', 'n1', 'guest');
  const reads: string[] = [];
  let during: () => void = () => undefined;
  const route = createSessionReadRoutes({ access: run.access, brokerState: run.state,
    sessionBindings: { recoverBinding: async () => undefined, sessionRead: async (_host: unknown, _binding: unknown, path: string) => { reads.push(path); during(); return { status: 200, body: '{"rows":[]}' }; } } as never });
  return { ...run, route, binding, reads, duringRead(action: () => void) { during = action; } };
};

describe('reading a bound session', () => {
  it('answers the session creator and refuses another guest before asking the Controller', async () => {
    const run = setup();
    await expect(run.call(run.route, 'GET', '/v1/sessions/a1/snapshot', undefined, 'guest')).resolves.toMatchObject({ status: 200, body: { rows: [] } });
    run.state.sharing.set('h1', 'other', 'Other', 10);
    await expect(run.call(run.route, 'GET', '/v1/sessions/a1/snapshot', undefined, 'other')).rejects.toMatchObject({ status: 403, code: 'session_forbidden' });
    expect(run.reads).toEqual(['/v1/sessions/a1/snapshot']);
  });

  it('withholds the answer when the guest lost access while the Controller was reading', async () => {
    const run = setup();
    run.duringRead(() => run.state.sharing.revoke('h1', 'guest'));
    await expect(run.call(run.route, 'GET', '/v1/sessions/a1/timeline', undefined, 'guest')).rejects.toMatchObject({ status: 403, code: 'session_forbidden' });
    expect(run.reads).toHaveLength(1);
  });
});
