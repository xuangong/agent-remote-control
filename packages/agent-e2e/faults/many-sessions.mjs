// The many-sessions generator: a seeded plan of sessions, one large group of bots and the open, fold, sleep and wake actions
// that a scenario applies to them. The plan is data, so the same seed gives the same churn on any host; creating the
// sessions is the scenario's job (a real instance creates them through its Controller, the Node host from fixtures).
import { seededRandom } from './seeded-random.mjs';

const PROVIDERS = ['claude', 'codex', 'copilot'];

/**
 * Plans `sessionCount` sessions across the providers, a group of the first `groupSize` of them, and `actions` churn actions.
 * Each action is `{ at, action, session }` with `at` in milliseconds from the start and `action` one of `open`, `fold`,
 * `sleep` and `wake`. A session is woken only after it slept and opened only while it is not folded or asleep.
 */
export function planManySessions({ seed = 1, sessionCount = 200, groupSize = 50, actions = 400, spacingMs = 250 } = {}) {
  if (groupSize > sessionCount) throw new Error('The group cannot be larger than the number of sessions.');
  const random = seededRandom(seed);
  const sessions = Array.from({ length: sessionCount }, (_, at) => ({ id: `s${String(at + 1).padStart(3, '0')}`, provider: PROVIDERS[at % PROVIDERS.length] }));
  const group = sessions.slice(0, groupSize).map(session => session.id);
  const state = new Map(sessions.map(session => [session.id, 'closed']));
  const plan = [];
  for (let step = 0; step < actions; step += 1) {
    const session = random.pick(sessions).id;
    const current = state.get(session);
    const choices = current === 'closed' ? ['open'] : current === 'open' ? ['fold', 'sleep', 'open'] : current === 'folded' ? ['open', 'sleep'] : ['wake'];
    const action = random.pick(choices);
    state.set(session, action === 'open' || action === 'wake' ? 'open' : action === 'fold' ? 'folded' : 'asleep');
    plan.push({ at: step * spacingMs, action, session });
  }
  return { seed, sessions, group, plan };
}
