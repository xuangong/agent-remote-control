import { describe, expect, it } from 'vitest';

import { createTeamRoutes } from './team-routes.js';
import { routeFixture } from './test-utils/route-fixture.js';

const resolve = { teamId: 't1', action: 'close_room' };
const setup = (teamHost = 'h1') => {
  const run = routeFixture();
  const done: string[] = []; let who = "owner"; let during = () => {};
  const brokerState = { teams: [{ id: 't1', source: { hostId: teamHost, providerId: 'codex', nativeSessionId: 'n1' } } as never] } as never;
  const teams = { action: async (input: { teamId: string }) => { done.push("action"); who = "guest"; during(); return { id: input.teamId }; }, delete: async () => { done.push('delete'); },
    readForClient: (id: string) => ({ id }), ask: async (input: { bot: string }) => { done.push(`ask ${input.bot}`); return { id: 'answer' }; } };
  const route = createTeamRoutes({ access: run.access, brokerState, teams: teams as never });
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
    expect(run.done).toEqual([]);
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve)).resolves.toMatchObject({ status: 200, body: { id: 't1' } });
    expect(run.done).toEqual(['action']);
  });

  it('refuses a Team whose Host the caller may not reach, without acting', async () => {
    const run = setup('gone');
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve)).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual([]);
  });

  it("does not answer a change when the connection stopped belonging to the owner while it ran", async () => {
    const run = setup();
    await expect(run.call(run.route, "POST", "/v1/remote/teams/action", resolve, "owner", run.who)).resolves.toMatchObject({ status: 409, body: { error: "Only the Host owner can manage this Host." } });
    expect(run.done).toEqual(["action"]);
  });

  it('does not answer a change whose Host went away while it ran', async () => {
    const run = setup();
    run.during(() => run.state.hosts.delete('h1'));
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/action', resolve, 'owner', 'owner')).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual(['action']);
  });

  it('takes the person\'s mention as the owner\'s call, from a Host the caller reaches, and refuses a body that is not one', async () => {
    const run = setup();
    const mention = { operationId: 'op1', source: { hostId: 'h1', providerId: 'codex', nativeSessionId: 'n1', title: 'Notes' }, bot: 'Reviewer', text: 'Anything new?' };
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/ask', mention, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/ask', { ...mention, text: '' })).resolves.toMatchObject({ status: 400 });
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/ask', { ...mention, source: { ...mention.source, hostId: 'gone' } })).resolves.toMatchObject({ status: 409, body: { error: 'Host is unavailable.' } });
    expect(run.done).toEqual([]);
    await expect(run.call(run.route, 'POST', '/v1/remote/teams/ask', mention)).resolves.toMatchObject({ status: 200, body: { id: 'answer' } });
    expect(run.done).toEqual(['ask Reviewer']);
  });
});
