import { describe, expect, it } from 'vitest';

import { createTeamRoutes } from './team-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const resolve = { teamId: 't1', action: 'resolve_message', messageId: 'm1', outcome: 'accepted' };
const setup = (teamHost = 'h1') => {
  const run = routeFixture();
  const done: string[] = []; let who = "owner"; let during = () => {};
  const brokerState = { teams: [{ id: 't1', source: { hostId: teamHost, providerId: 'codex', nativeSessionId: 'n1' } } as never] } as never;
  const teams = { action: async (input: { teamId: string }) => { done.push("action"); who = "guest"; during(); return { id: input.teamId }; }, delete: async () => { done.push('delete'); },
    readForClient: (id: string) => ({ id }) };
  const route = createTeamRoutes({ access: run.access, brokerState, now: () => 1_000, teams: teams as never,
    callForSupportChange: (async () => undefined) as never, resolveRole: (() => { throw new Error('unused'); }) as never });
  return { ...run, route, done, who: () => who, during(action: () => void) { during = action; } };
};

describe('Team routes', () => {
  it('are the owner\'s: a guest of the Host reads and changes no Team', async () => {
    const run = setup();
    await expect(run.call(run.route, 'GET', '/v1/remote/teams', undefined, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    expect(run.done).toEqual([]);
  });

  it('answers 404 for a Team that does not exist, and acts on one that does', async () => {
    const run = setup();
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', { ...resolve, teamId: 'missing' })).resolves.toMatchObject({ status: 404, body: { error: 'Team not found.' } });
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/delete', { teamId: 'missing' })).resolves.toMatchObject({ status: 404 });
    expect(run.done).toEqual([]);
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve)).resolves.toMatchObject({ status: 200, body: { id: 't1' } });
    expect(run.done).toEqual(['action']);
  });

  it('refuses a Team whose Host the caller may not reach, without acting', async () => {
    const run = setup('gone');
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve)).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/delete', { teamId: 't1' })).resolves.toMatchObject({ status: 409 });
    expect(run.done).toEqual([]);
  });

  it("does not answer a change when the connection stopped belonging to the owner while it ran", async () => {
    const run = setup();
    await expect(run.call(run.route, "POST", "/v1/remote/teams/action", resolve, "owner", run.who)).resolves.toMatchObject({ status: 409, body: { error: "Only the Host owner can manage this Host." } });
    expect(run.done).toEqual(["action"]);
  });

  it('refuses to add a member on a Host the caller may not reach, and does not answer a change whose Host went away while it ran', async () => {
    const run = setup();
    const add = { teamId: 't1', action: 'add_member', operationId: 'op1', hostId: 'ghost', providerId: 'codex', cwd: '/w', name: 'Member', responsibility: 'Review' };
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', add)).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual([]);
    run.during(() => run.state.hosts.delete('h1'));
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', { ...resolve, }, 'owner', 'owner')).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual(['action']);
  });

  it('does not answer a member addition whose member Host went away while it ran', async () => {
    const run = setup();
    run.state.hosts.set('h2', { ...run.host, id: 'h2', installationId: 'second' });
    const add = { teamId: 't1', action: 'add_member', operationId: 'op1', hostId: 'h2', providerId: 'codex', cwd: '/w', name: 'Member', responsibility: 'Review' };
    run.during(() => run.state.hosts.delete('h2'));
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', add)).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual(['action']);
  });
});
