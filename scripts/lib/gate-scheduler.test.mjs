import assert from 'node:assert/strict';
import test from 'node:test';
import { decideNext, DEFAULT_LIMITS, runSchedule, tierCommand, TIER_PROFILES } from './gate-scheduler.mjs';
import { busyCoresBetween, matchingMiB, parseMeminfo, parseProcessTable, parseVmStat, pressureName, treeMiB } from './machine-state.mjs';

const GIB = 1024;
const profiles = {
  verify: { memoryMiB: 4 * GIB, cores: 6 },
  components: { memoryMiB: 2 * GIB, cores: 1.5, needs: 'verify', workers: { max: 3, extraMemoryMiB: GIB, extraCores: 1 } },
  'e2e-chromium': { memoryMiB: 2 * GIB, cores: 2, needs: 'verify' },
  'e2e-webkit': { memoryMiB: 2 * GIB, cores: 2, needs: 'verify' },
  smoke: { memoryMiB: 3 * GIB, cores: 3, needs: 'verify', exclusive: true },
};
const limits = { ...DEFAULT_LIMITS, reserveMiB: 3 * GIB, cpuCeiling: 1 };
const tier = id => ({ id });
const machine = (overrides = {}) => ({ availableMiB: 12 * GIB, pressure: 'normal', load1: 1, cores: 10, ...overrides });
const decide = (overrides = {}) => decideNext({ pending: [tier('components'), tier('e2e-chromium')], running: [], milestones: new Set(['verify']), machine: machine(), limits, profiles, ...overrides });

test('the first tier starts on an idle machine and takes as many workers as fit', () => {
  const { start } = decide({ machine: machine({ availableMiB: 16 * GIB }) });
  assert.equal(start.tier.id, 'components');
  assert.equal(start.workers, 3);
});

test('workers shrink to the memory left after the reserve', () => {
  assert.equal(decide({ machine: machine({ availableMiB: 5.9 * GIB }) }).start.workers, 1);
  assert.equal(decide({ machine: machine({ availableMiB: 6 * GIB }) }).start.workers, 2);
});

test('a second tier starts only when its peak fits in the memory left after the reserve and the running tier\'s growth', () => {
  const running = [{ tier: tier('components'), rssMiB: 0.5 * GIB }];
  const fits = decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 8 * GIB }) });
  assert.equal(fits.start.tier.id, 'e2e-chromium');
  // 8 GiB - 3 reserve - 1.5 growth leaves 3.5 GiB; at 6 GiB available only 1.5 GiB are left.
  const tight = decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 6 * GIB }) });
  assert.equal(tight.start, null);
  assert.match(tight.reason, /e2e-chromium waits: needs 2\.0 GiB, 1\.5 GiB free/);
});

test('observed memory above the profile leaves no growth to reserve', () => {
  const running = [{ tier: tier('components'), rssMiB: 3 * GIB }];
  assert.equal(decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 5.2 * GIB }) }).start.tier.id, 'e2e-chromium');
});

test('CPU load blocks a second tier even when memory is plentiful', () => {
  const running = [{ tier: tier('verify'), rssMiB: 4 * GIB }];
  const blocked = decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 20 * GIB, load1: 9 }) });
  assert.equal(blocked.start, null);
  assert.match(blocked.reason, /needs 2 cores, 1\.0 free/);
  assert.equal(decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 20 * GIB, load1: 3 }) }).start.tier.id, 'e2e-chromium');
});

test('memory pressure holds new tiers while one runs, and a lone tier waits a bounded time for it to fall', () => {
  const running = [{ tier: tier('components'), rssMiB: 2 * GIB }];
  for (const pressure of ['warn', 'critical']) {
    assert.match(decide({ running, machine: machine({ pressure }) }).reason, new RegExp(`memory pressure is ${pressure}`));
  }
  assert.equal(decide({ machine: machine({ pressure: 'critical' }) }).start, null);
  assert.equal(decide({ machine: machine({ pressure: 'critical' }), idleMs: limits.idleWaitMs }).start.tier.id, 'components');
});

test('the parallel limit and a failure stop new starts', () => {
  const running = [{ tier: tier('components'), rssMiB: 2 * GIB }, { tier: tier('e2e-webkit'), rssMiB: 2 * GIB }];
  assert.match(decide({ pending: [tier('e2e-chromium')], running, limits: { ...limits, maxParallel: 2 } }).reason, /2 tiers are running/);
  assert.match(decide({ stopped: true }).reason, /failed/);
});

test('a tier waits for verify', () => {
  const blocked = decide({ milestones: new Set() });
  assert.equal(blocked.start, null);
  assert.match(blocked.reason, /components waits for verify/);
});

test('smoke runs alone and last', () => {
  assert.equal(decide({ pending: [tier('e2e-chromium'), tier('smoke')] }).start.tier.id, 'e2e-chromium');
  const running = [{ tier: tier('e2e-chromium'), rssMiB: 2 * GIB }];
  assert.match(decide({ pending: [tier('smoke')], running }).reason, /smoke runs alone and last/);
  assert.equal(decide({ pending: [tier('smoke')] }).start.tier.id, 'smoke');
});

test('a tier that fits later is started ahead of one that does not', () => {
  const running = [{ tier: tier('verify'), rssMiB: 4 * GIB }];
  const { start } = decide({ pending: [tier('e2e-chromium'), tier('e2e-webkit')], running, machine: machine({ availableMiB: 20 * GIB, load1: 3 }) });
  assert.equal(start.tier.id, 'e2e-chromium');
});

/** A virtual clock: timers fire in time order each time every task is waiting. */
function virtualWorld({ durations, readings = [], codes = {}, memory = {} }) {
  let time = 0;
  const timers = [];
  const at = (when, fire) => timers.push({ when, fire });
  const log = [];
  const started = [];
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const ports = {
    now: () => time,
    sleep: ms => new Promise(resolve => at(time + ms, resolve)),
    log: line => log.push(line),
    readMachine: () => ({ ...machine({ availableMiB: 16 * GIB }), ...readings.findLast(([from]) => from <= time)?.[1] }),
    memoryOf: pid => memory[pid] ?? 1 * GIB,
    launch: spec => {
      const pid = 100 + started.length;
      started.push({ id: spec.id, at: time });
      let end;
      const done = new Promise(resolve => { end = () => resolve({ code: codes[spec.id] ?? 0 }); });
      at(time + durations[spec.id] * 1000, end);
      return { handle: { pid }, done };
    },
  };
  const drive = async run => {
    let finished = false;
    const result = run().finally(() => { finished = true; });
    while (!finished) {
      await settle();
      if (finished) break;
      timers.sort((a, b) => a.when - b.when);
      const next = timers.shift();
      if (!next) break;
      time = Math.max(time, next.when);
      next.fire();
    }
    return result;
  };
  return { ports, drive, log, started };
}

const plan = ids => ids.map(tier);

test('verify runs alone first, then the browser tiers run together within the parallel limit, and smoke runs last', async () => {
  const world = virtualWorld({ durations: { verify: 360, components: 600, 'e2e-chromium': 240, 'e2e-webkit': 250, smoke: 400 } });
  const { results, skipped } = await world.drive(() => runSchedule({ tiers: plan(['verify', 'components', 'e2e-chromium', 'e2e-webkit', 'smoke']), limits: { ...limits, maxParallel: 3 }, profiles, ...world.ports }));
  assert.deepEqual(world.started.map(({ id, at }) => [id, at]), [['verify', 0], ['components', 360000], ['e2e-chromium', 360000], ['e2e-webkit', 360000], ['smoke', 960000]]);
  assert.deepEqual(results.map(result => result.code), [0, 0, 0, 0, 0]);
  assert.deepEqual(skipped, []);
  assert.equal(Math.max(...results.map(result => result.endedMs)), 1360000);
});

test('a serial run starts the next tier only when the previous one is done', async () => {
  const world = virtualWorld({ durations: { verify: 100, 'e2e-chromium': 50, 'e2e-webkit': 50 } });
  await world.drive(() => runSchedule({ tiers: plan(['verify', 'e2e-chromium', 'e2e-webkit']), limits: { ...limits, maxParallel: 1 }, profiles, ...world.ports }));
  assert.deepEqual(world.started.map(({ id, at }) => [id, at]), [['verify', 0], ['e2e-chromium', 100000], ['e2e-webkit', 150000]]);
});

test('without verify in the run the other tiers start at once', async () => {
  const world = virtualWorld({ durations: { 'e2e-chromium': 50, 'e2e-webkit': 50 } });
  await world.drive(() => runSchedule({ tiers: plan(['e2e-chromium', 'e2e-webkit']), limits, profiles, ...world.ports }));
  assert.deepEqual(world.started.map(({ id, at }) => [id, at]), [['e2e-chromium', 0], ['e2e-webkit', 0]]);
});

test('a tier waits until memory pressure falls, then starts', async () => {
  const world = virtualWorld({
    durations: { 'e2e-chromium': 100, 'e2e-webkit': 50 },
    readings: [[0, {}], [10_000, { pressure: 'warn' }], [70_000, { pressure: 'normal' }]],
  });
  // e2e-webkit's turn comes at 0 with chromium running; the pressure arrives at 10 s, so start it before and check the other order too.
  const { results } = await world.drive(() => runSchedule({ tiers: plan(['e2e-chromium', 'e2e-webkit']), limits: { ...limits, maxParallel: 1 }, profiles, ...world.ports, readMachine: () => ({ ...machine(), pressure: world.ports.now() >= 10_000 && world.ports.now() < 120_000 ? 'warn' : 'normal' }) }));
  assert.deepEqual(world.started.map(({ id, at }) => [id, at]), [['e2e-chromium', 0], ['e2e-webkit', 120000]]);
  assert.equal(results.length, 2);
  assert.ok(world.log.some(line => /waiting: .*memory pressure/.test(line)));
});

test('after a failure the running tiers finish, nothing new starts and the rest is reported skipped', async () => {
  const world = virtualWorld({ durations: { verify: 100, components: 300, 'e2e-chromium': 20, 'e2e-webkit': 20 }, codes: { 'e2e-chromium': 1, 'e2e-webkit': 0 } });
  const { results, skipped } = await world.drive(() => runSchedule({ tiers: plan(['verify', 'components', 'e2e-chromium', 'e2e-webkit']), limits: { ...limits, maxParallel: 2 }, profiles, ...world.ports }));
  assert.deepEqual(results.map(result => [result.tier, result.code]).sort(), [['components', 0], ['e2e-chromium', 1], ['verify', 0]]);
  assert.deepEqual(skipped, ['e2e-webkit']);
  const failedEarly = virtualWorld({ durations: { verify: 10, components: 5 }, codes: { verify: 1 } });
  const outcome = await failedEarly.drive(() => runSchedule({ tiers: plan(['verify', 'components']), limits, profiles, ...failedEarly.ports }));
  assert.deepEqual(outcome.skipped, ['components']);
});

test('the peak memory observed for a tier is reported and each decision is logged with the readings', async () => {
  const world = virtualWorld({ durations: { 'e2e-chromium': 30 }, memory: { 100: 1.8 * GIB } });
  const { results } = await world.drive(() => runSchedule({ tiers: plan(['e2e-chromium']), limits, profiles, ...world.ports }));
  assert.ok(results[0].peakMiB >= 0);
  assert.match(world.log[0], /e2e-chromium starts, nothing else running \(16\.0 GiB available, 3\.0 GiB reserved/);
});

test('vm_stat counts free, inactive, purgeable and speculative pages', () => {
  const text = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               1000.\nPages active:                             5000.\nPages inactive:                           2000.\nPages speculative:                         500.\nPages purgeable:                           100.\n';
  assert.equal(parseVmStat(text), Math.round(3600 * 16384 / 1048576));
});

test('meminfo uses MemAvailable, else free plus inactive', () => {
  assert.equal(parseMeminfo('MemTotal: 16000000 kB\nMemFree: 1000000 kB\nMemAvailable: 8388608 kB\n'), 8192);
  assert.equal(parseMeminfo('MemFree: 1048576 kB\nInactive: 1048576 kB\n'), 2048);
});

test('the pressure level names and the process tree memory', () => {
  assert.deepEqual([1, 2, 4].map(pressureName), ['normal', 'warn', 'critical']);
  const table = parseProcessTable('  10     1  2048\n  11    10  1024\n  12    11   512\n  20     1  9999\n');
  assert.equal(treeMiB(table, 10), 3.5);
  assert.equal(treeMiB(table, 99), 0);
});

test('the memory of processes outside the tree, such as Playwright WebKit helpers, can be added by command', () => {
  const table = parseProcessTable('  10     1  1024 node run\n  30     1  2048 /x/ms-playwright/webkit-2336/Playwright.app\n');
  assert.equal(matchingMiB(table, /ms-playwright\/webkit/), 2);
});

test('busy cores come from the CPU times between two readings, and a too short interval gives none', () => {
  assert.equal(busyCoresBetween({ busy: 0, total: 0 }, { busy: 4000, total: 10000 }, 10), 4);
  assert.equal(busyCoresBetween({ busy: 0, total: 0 }, { busy: 10, total: 100 }, 10), undefined);
});

test('granted workers and a retry become arguments of the tier\'s command, and one worker without retry changes nothing', () => {
  assert.deepEqual(tierCommand(['pnpm', 'test:components'], 'components', { workers: 2 }), ['pnpm', 'test:components', '--workers', '2']);
  assert.deepEqual(tierCommand(['pnpm', 'test:e2e:flows', 'flows/e1-'], 'e2e-webkit', { workers: 2, retry: true }), ['pnpm', 'test:e2e:flows', 'flows/e1-', '--fileParallelism', '--maxWorkers=2', '--retry=1']);
  assert.deepEqual(tierCommand(['pnpm', 'test:components'], 'components', { retry: true }), ['pnpm', 'test:components', '--retries', '1']);
  assert.deepEqual(tierCommand(['pnpm', 'test:components'], 'components', {}), ['pnpm', 'test:components']);
  assert.deepEqual(tierCommand(['pnpm', 'verify'], 'verify', { workers: 3, retry: true }), ['pnpm', 'verify']);
  assert.ok(TIER_PROFILES.components.workers.max >= 2);
});

test('a long run prints the running tiers, their memory and the machine once a heartbeat', async () => {
  const world = virtualWorld({ durations: { 'e2e-chromium': 200 }, memory: { 100: 1.5 * GIB } });
  await world.drive(() => runSchedule({ tiers: plan(['e2e-chromium']), limits, profiles, heartbeatMs: 60_000, ...world.ports }));
  const status = world.log.filter(line => /running: e2e-chromium 1\.5 GiB; 16\.0 GiB available/.test(line));
  assert.equal(status.length, 3);
});

test('a running tier counts the memory and cores of the workers it was given', () => {
  const running = [{ tier: tier('components'), workers: 3, rssMiB: 0 }];
  // components at 3 workers: 2 + 2 GiB of growth and 1.5 + 2 cores; 12 GiB available leaves 12 - 3 - 4 = 5 GiB and 6.5 cores.
  assert.equal(decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 12 * GIB, busyCores: 0 }) }).start.tier.id, 'e2e-chromium');
  assert.match(decide({ pending: [tier('e2e-chromium')], running, machine: machine({ availableMiB: 8 * GIB, busyCores: 0 }) }).reason, /needs 2\.0 GiB, 1\.0 GiB free/);
  const busy = decide({ pending: [tier('e2e-chromium')], running: [{ tier: tier('components'), workers: 3, rssMiB: 3 * GIB }], machine: machine({ availableMiB: 12 * GIB, busyCores: 0, cores: 5 }) });
  assert.match(busy.reason, /needs 2 cores, 1\.5 free/);
});

test('by default the gate keeps to 60 percent of the cores, so a two-worker component run is alone', () => {
  const defaults = { ...DEFAULT_LIMITS, reserveMiB: 3 * GIB };
  const idle = decide({ limits: defaults, profiles: TIER_PROFILES, machine: machine({ availableMiB: 16 * GIB, busyCores: 0 }) });
  assert.deepEqual([idle.start.tier.id, idle.start.workers], ['components', 2]);
  const running = [{ tier: tier('components'), workers: 2, rssMiB: 3 * GIB }];
  assert.match(decide({ pending: [tier('e2e-chromium')], running, limits: defaults, profiles: TIER_PROFILES, machine: machine({ availableMiB: 16 * GIB, busyCores: 3 }) }).reason, /needs 2 cores, 0\.0 free/);
});
