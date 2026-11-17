import { readInstance } from '@orchardworks/agent-e2e/faults/instance-process.mjs';
import { seededRandom } from '@orchardworks/agent-e2e/faults/seeded-random.mjs';
import { loadChromium } from './probe.js';
import { SessionPool, type Provider } from './sessions.js';
import type { RunContext } from '../scenario.js';

/** Builds the run's context: the instance of this checkout, one headless browser, a pool of own sessions and the seeded generator. */
export async function createRunContext({ checkout, seed, quick, runDirectory, log }: { checkout: string; seed: number; quick: boolean; runDirectory: string; log: (message: string) => void }): Promise<{ context: RunContext; close(): Promise<void> }> {
  const instance = await readInstance();
  if (instance.state !== 'running') throw new Error(`The instance is ${instance.state}; run pnpm local up first.`);
  const pool = new SessionPool(checkout, log);
  const browser = await loadChromium(checkout).launch({ headless: true });
  const withHistory = new Map<Provider, Promise<string>>();
  const startedAt = Date.now();
  const context: RunContext = {
    checkout, instance, seed, quick, random: seededRandom(seed), pool, browser, runDirectory, log,
    now: () => Date.now() - startedAt,
    sessionWithHistory(provider) {
      let address = withHistory.get(provider);
      if (!address) {
        address = (async () => {
          const created = await pool.create(provider, 'Reply with the single word READY and nothing else.');
          await pool.waitForReply(created, undefined);
          await pool.turn(created, 'Now reply with the single word AGAIN and nothing else.');
          return created;
        })();
        withHistory.set(provider, address);
      }
      return address;
    },
  };
  return { context, async close() { await browser.close().catch(() => {}); await pool.releaseAll(); } };
}
