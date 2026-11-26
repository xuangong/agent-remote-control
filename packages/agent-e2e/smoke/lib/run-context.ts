import { readInstance } from '../../faults/instance-process.mjs';
import { seededRandom } from '../../faults/seeded-random.mjs';
import { loadChromium } from './probe.js';
import { SessionPool, type Provider } from './sessions.js';
import { ScenarioEvidence } from '../evidence.js';
import type { RunContext } from '../scenario.js';

/** Builds the run's context: the instance of this checkout, one headless browser, a pool of own sessions and the seeded generator. */
export async function createRunContext({ checkout, seed, quick, runDirectory, log }: { checkout: string; seed: number; quick: boolean; runDirectory: string; log: (message: string) => void }): Promise<{ context: RunContext; close(): Promise<void> }> {
  const instance = await readInstance();
  if (instance.state !== 'running') throw new Error(`The instance is ${instance.state}; run pnpm local up first.`);
  const pool = new SessionPool(checkout, log);
  const browser = await loadChromium(checkout).launch({ headless: true });
  /** One session per provider and kind of history, created on first use and shared by the scenarios of the run. */
  const cache = new Map<string, Promise<string>>();
  const history = (provider: Provider, kind: string, turns: string[]): Promise<string> => {
    const key = `${provider}:${kind}`;
    let address = cache.get(key);
    if (!address) {
      address = (async () => {
        const created = await pool.create(provider, 'Reply with the single word READY and nothing else.');
        await pool.waitForReply(created, undefined);
        for (const turn of turns) await pool.turn(created, turn);
        return created;
      })();
      cache.set(key, address);
    }
    return address;
  };
  const startedAt = Date.now();
  const context: RunContext = {
    checkout, instance, seed, quick, random: seededRandom(seed), pool, browser, runDirectory, log,
    evidence: new ScenarioEvidence(),
    now: () => Date.now() - startedAt,
    sessionWithHistory: provider => history(provider, 'short', ['Now reply with the single word AGAIN and nothing else.']),
    sessionWithLongHistory: provider => history(provider, 'long', ['Print the integers from 1 to 150, one per line, with no other text.', 'Now reply with the single word AGAIN and nothing else.']),
  };
  return { context, async close() { await browser.close().catch(() => {}); await pool.releaseAll(); } };
}
