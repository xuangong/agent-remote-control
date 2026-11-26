// The resource-aware scheduler of the release gate: which tiers of a plan run at the same time on this machine.
// A tier starts when the tiers it needs have reached their milestone and the machine has room for its measured peak memory
// and CPU on top of what is running (plus a reserve for the owner's own apps). The decision is a pure function of the
// readings (`decideNext`); `runSchedule` loops it over injected ports, so tests run it with fake readings and a virtual clock.
// The commands and the reading of the machine live in scripts/release-gate.mjs and scripts/lib/machine-state.mjs.

const GIB = 1024;

/**
 * What each tier costs, measured on the 10-core, 16 GiB Mac mini with each tier run alone on an otherwise idle machine
 * (docs/superpowers/reviews/2026-11-26-test-gate-retrospective.md): `memoryMiB` is the fall of the memory the system can give away
 * (free + inactive + purgeable) while the tier ran, with a margin of about a quarter; `cores` is the CPU it keeps busy, counted
 * over its whole run with a margin, since the Vitest and Playwright bursts are short. `needs` names the milestone that must be reached
 * first: `verify` is the end of the verify tier. Verify rebuilds the package outputs and the Workbench `dist` the other tiers read,
 * and its process-spawning unit tests fail under load (the opencode supervisor test and the one-second speed rule did, in two of
 * two runs that overlapped it with a browser tier), so nothing runs beside it. A tier with `workers` can run several workers (`flags(n)` are the arguments that ask for n); each extra worker adds the given
 * memory and cores. The e2e flows were measured with two workers (about half the time, every flow passing); the components ran in half the time
 * with three workers but one WebKit phone spec failed under a load of 16 (it passes alone), so two are the most asked for. `exclusive` tiers run alone and last: smoke rebuilds the Relay, the devbox and the Workbench
 * for the local instance, so nothing may read those outputs while it runs.
 */
/** Vitest runs the flow files one at a time; each file has its own stack on free ports, so files can run in separate workers. */
const E2E_WORKER_FLAGS = count => ['--fileParallelism', `--maxWorkers=${count}`];
export const TIER_PROFILES = {
  verify: { memoryMiB: 3.2 * GIB, cores: 3 },
  components: { memoryMiB: 2 * GIB, cores: 1.5, needs: 'verify', workers: { max: 2, extraMemoryMiB: 0.7 * GIB, extraCores: 1, flags: count => ['--workers', String(count)] } },
  'preview-browser': { memoryMiB: 1.4 * GIB, cores: 1, needs: 'verify' },
  'e2e-chromium': { memoryMiB: 1 * GIB, cores: 1, needs: 'verify', workers: { max: 2, extraMemoryMiB: 0.6 * GIB, extraCores: 1, flags: E2E_WORKER_FLAGS } },
  'e2e-webkit': { memoryMiB: 1.3 * GIB, cores: 1, needs: 'verify', workers: { max: 2, extraMemoryMiB: 0.6 * GIB, extraCores: 1, flags: E2E_WORKER_FLAGS } },
  smoke: { memoryMiB: 1 * GIB, cores: 1, needs: 'verify', exclusive: true },
};
/** A tier without a measured profile is assumed heavy, so it never overlaps blindly. */
const UNKNOWN_PROFILE = { memoryMiB: 3 * GIB, cores: 3, needs: 'verify' };
export const profileOf = (id, profiles = TIER_PROFILES) => profiles[id] ?? UNKNOWN_PROFILE;

export const DEFAULT_LIMITS = {
  /** Memory kept free for the owner's apps and other agents. The Mac mini has 4 to 5 GiB available when idle, so a larger reserve never overlaps tiers. */
  reserveMiB: 2 * GIB,
  /** Most tiers at once. */
  maxParallel: 3,
  /** The share of the cores the gate may keep busy (the larger of the cores busy now and the running tiers' declared cores). */
  cpuCeiling: 1,
  /** How long a tier waits for memory pressure to fall when nothing else is running, before it starts anyway. */
  idleWaitMs: 2 * 60_000,
};

/** The most Playwright workers of a tier that fit in the headroom, at least one. */
function workersThatFit(profile, room) {
  const spec = profile.workers;
  if (!spec) return 1;
  for (let workers = spec.max; workers > 1; workers--) {
    const extra = workers - 1;
    if (profile.memoryMiB + extra * spec.extraMemoryMiB <= room.memoryMiB && profile.cores + extra * spec.extraCores <= room.cores) return workers;
  }
  return 1;
}

const gib = mib => `${(mib / GIB).toFixed(1)} GiB`;

/**
 * The next tier to start, or why none can.
 * - `pending`: tiers of the plan not started, in plan order; `running`: `{ tier, rssMiB }` for each running tier (rssMiB is the
 *   observed memory of its process tree); `milestones`: the milestone names reached; `machine`: `{ availableMiB, pressure, load1, busyCores, cores }`.
 * - `idleMs`: how long nothing has been running while a tier waited (see `idleWaitMs`); `stopped`: a tier failed, start nothing new.
 * Returns `{ start: { tier, workers }, reason }` or `{ start: null, reason }`.
 */
export function decideNext({ pending, running, milestones, machine, limits = DEFAULT_LIMITS, profiles = TIER_PROFILES, idleMs = 0, stopped = false }) {
  if (stopped) return { start: null, reason: 'a tier failed; nothing new starts' };
  const growthMiB = running.reduce((sum, { tier, rssMiB }) => sum + Math.max(0, profileOf(tier.id, profiles).memoryMiB - rssMiB), 0);
  const demandCores = running.reduce((sum, { tier }) => sum + profileOf(tier.id, profiles).cores, 0);
  const room = {
    memoryMiB: machine.availableMiB - limits.reserveMiB - growthMiB,
    cores: machine.cores * limits.cpuCeiling - Math.max(machine.busyCores ?? machine.load1, demandCores),
  };
  const numbers = `${gib(machine.availableMiB)} available, ${gib(limits.reserveMiB)} reserved, ${gib(growthMiB)} still to be used by ${running.length} running; ${(machine.busyCores ?? machine.load1).toFixed(1)} of ${machine.cores} cores busy; pressure ${machine.pressure}`;
  const reasons = [];
  for (const tier of pending) {
    const profile = profileOf(tier.id, profiles);
    if (profile.needs && !milestones.has(profile.needs)) { reasons.push(`${tier.id} waits for ${profile.needs}`); continue; }
    if (profile.exclusive && (running.length || pending.length > 1)) { reasons.push(`${tier.id} runs alone and last`); continue; }
    if (running.length >= limits.maxParallel) { reasons.push(`${tier.id} waits: ${limits.maxParallel} tiers are running`); continue; }
    if (!running.length) {
      if (machine.pressure !== 'normal' && idleMs < limits.idleWaitMs) { reasons.push(`${tier.id} waits for memory pressure to fall`); continue; }
      return { start: { tier, workers: workersThatFit(profile, { memoryMiB: Math.max(room.memoryMiB, profile.memoryMiB), cores: machine.cores }) }, reason: `${tier.id} starts, nothing else running (${numbers})` };
    }
    if (machine.pressure !== 'normal') { reasons.push(`${tier.id} waits: memory pressure is ${machine.pressure}`); continue; }
    if (room.memoryMiB < profile.memoryMiB) { reasons.push(`${tier.id} waits: needs ${gib(profile.memoryMiB)}, ${gib(Math.max(0, room.memoryMiB))} free to use`); continue; }
    if (room.cores < profile.cores) { reasons.push(`${tier.id} waits: needs ${profile.cores} cores, ${Math.max(0, room.cores).toFixed(1)} free`); continue; }
    return { start: { tier, workers: workersThatFit(profile, room) }, reason: `${tier.id} starts (${numbers}; needs ${gib(profile.memoryMiB)}, ${profile.cores} cores)` };
  }
  return { start: null, reason: reasons.length ? `${reasons.join('; ')} (${numbers})` : 'nothing pending' };
}

/**
 * Runs a plan's tiers with `decideNext`. Ports:
 * - `readMachine()`: the machine reading; `memoryOf(pid, tier)`: the MiB of a tier's process tree (0 if gone);
 * - `launch(tier, { workers, milestone })`: starts a tier and returns `{ handle, done }`; `handle.pid` is the process now running
 *   for the tier and `done` resolves `{ code }`; the tier calls `milestone(name)` when it reaches one;
 * - `sleep(ms)`, `now()`, `log(line)`.
 * `limits.maxParallel` of 1 is the serial run. A failed tier stops new starts; the running ones finish. Returns one result per
 * started tier, `{ tier, code, startedMs, endedMs, peakMiB, workers }`, `skipped` ids that never started, and the lowest available
 * memory and worst pressure seen as `observed`.
 */
export async function runSchedule({ tiers, limits = DEFAULT_LIMITS, profiles = TIER_PROFILES, readMachine, memoryOf, launch, sleep, now, log, pollMs = 2000, heartbeatMs = 60_000 }) {
  const pending = [...tiers];
  const running = new Map();
  const results = [];
  const milestones = new Set(tiers.some(tier => tier.id === 'verify') ? [] : ['verify']);
  let stopped = false, idleSince = null, lastReason = '', lastLogged = -Infinity, lastStatus = now();
  const observed = { minAvailableMiB: Infinity, worstPressure: 'normal' };
  const startedAt = now();
  const stamp = () => `[+${Math.round((now() - startedAt) / 1000)} s]`;
  while (pending.length || running.size) {
    const machine = await readMachine();
    observed.minAvailableMiB = Math.min(observed.minAvailableMiB, machine.availableMiB);
    if (machine.pressure !== 'normal') observed.worstPressure = machine.pressure === 'critical' || observed.worstPressure === 'critical' ? 'critical' : 'warn';
    for (const entry of running.values()) { entry.rssMiB = memoryOf(entry.handle.pid, entry.tier); entry.peakMiB = Math.max(entry.peakMiB, entry.rssMiB); }
    if (running.size && now() - lastStatus >= heartbeatMs) {
      lastStatus = now();
      log(`${stamp()} running: ${[...running.values()].map(entry => `${entry.tier.id} ${gib(entry.rssMiB)}`).join(', ')}; ${gib(machine.availableMiB)} available; ${(machine.busyCores ?? machine.load1).toFixed(1)} of ${machine.cores} cores busy; pressure ${machine.pressure}`);
    }
    if (!running.size && !pending.some(tier => !profileOf(tier.id, profiles).needs || milestones.has(profileOf(tier.id, profiles).needs))) break;
    const idleMs = running.size || idleSince === null ? 0 : now() - idleSince;
    const decision = decideNext({ pending, running: [...running.values()], milestones, machine, limits, profiles, idleMs, stopped });
    if (decision.start) {
      const { tier, workers } = decision.start;
      pending.splice(pending.indexOf(tier), 1);
      idleSince = null;
      log(`${stamp()} ${decision.reason}${workers > 1 ? `; ${workers} workers` : ''}`);
      const entry = { tier, workers, startedMs: now(), rssMiB: 0, peakMiB: 0, handle: undefined };
      const { handle, done } = launch(tier, { workers });
      entry.handle = handle;
      entry.done = done.then(({ code }) => {
        running.delete(tier.id);
        const result = { tier: tier.id, code, startedMs: entry.startedMs, endedMs: now(), peakMiB: entry.peakMiB, workers };
        results.push(result);
        if (code !== 0) stopped = true; else if (tier.id === 'verify') milestones.add('verify');
        log(`${stamp()} ${tier.id} finished with exit ${code} after ${Math.round((result.endedMs - result.startedMs) / 1000)} s; peak ${gib(entry.peakMiB)}`);
        return result;
      });
      running.set(tier.id, entry);
      continue;
    }
    if (stopped && !running.size) break;
    if (!running.size && idleSince === null) idleSince = now();
    // The readings change on every poll; a new line is printed when the cause of the wait changes, and once a heartbeat.
    const cause = decision.reason.replace(/[\d.]+/g, '#');
    if (pending.length && (cause !== lastReason || now() - lastLogged >= heartbeatMs)) {
      lastReason = cause; lastLogged = now();
      log(`${stamp()} waiting: ${decision.reason}`);
    }
    await Promise.race([sleep(pollMs), ...[...running.values()].map(entry => entry.done)]);
  }
  await Promise.all([...running.values()].map(entry => entry.done));
  return { results, skipped: pending.map(tier => tier.id), observed };
}

/** The command of a tier step with the arguments that ask for `workers` workers, when the tier supports them and more than one was granted. */
export function withWorkers(command, tierId, workers, profiles = TIER_PROFILES) {
  return workers > 1 && profiles[tierId]?.workers ? [...command, ...profiles[tierId].workers.flags(workers)] : command;
}
