// Readings of this machine for the release gate scheduler: memory that can be given to a new process, memory pressure, load,
// and the memory of a process tree. The parsers are pure; `readMachine` and `processTreeMiB` call the system tools.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, loadavg } from 'node:os';

const MIB = 1024 * 1024;

/** MiB the system can hand out from `vm_stat` output: free, inactive, purgeable and speculative pages. */
export function parseVmStat(text) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(text)?.[1] ?? 16384);
  const pages = name => Number(new RegExp(`^Pages ${name}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return Math.round(((pages('free') + pages('inactive') + pages('purgeable') + pages('speculative')) * pageSize) / MIB);
}

/** MiB available from `/proc/meminfo` (MemAvailable, else free plus inactive file and anonymous pages). */
export function parseMeminfo(text) {
  const kib = name => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1]);
  const available = kib('MemAvailable');
  return Math.round((Number.isFinite(available) ? available : (kib('MemFree') || 0) + (kib('Inactive') || 0)) / 1024);
}

/** `kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical) as a name. */
export const pressureName = level => (Number(level) >= 4 ? 'critical' : Number(level) >= 2 ? 'warn' : 'normal');

/** `{ pid: { ppid, rssMiB, command } }` from `ps -axo pid=,ppid=,rss=,command=` output. */
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), rssMiB: Number(match[3]) / 1024, command: match[4] });
  }
  return table;
}

/** The resident MiB of every process whose command matches a pattern, wherever it sits in the process tree. */
export function matchingMiB(table, pattern) {
  let total = 0;
  for (const { rssMiB, command } of table.values()) if (pattern.test(command)) total += rssMiB;
  return total;
}

/** The resident MiB of a process and all its descendants. */
export function treeMiB(table, rootPid) {
  const children = new Map();
  for (const [pid, { ppid }] of table) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  let total = 0;
  const queue = [rootPid];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    total += table.get(pid)?.rssMiB ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

const run = (command, args) => { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000 }); return result.status === 0 ? result.stdout : ''; };

/** The cores' busy time and total time so far, from `os.cpus()`. */
const cpuTimes = () => cpus().reduce((sum, { times }) => ({ busy: sum.busy + times.user + times.nice + times.sys + times.irq, total: sum.total + times.user + times.nice + times.sys + times.irq + times.idle }), { busy: 0, total: 0 });
let lastCpu = cpuTimes();

/** The cores' busy share between two `cpuTimes` readings as a number of cores, or undefined when under half a second passed. */
export const busyCoresBetween = (before, after, cores) => ((after.total - before.total) / cores >= 500 ? ((after.busy - before.busy) / (after.total - before.total)) * cores : undefined);

/** `{ availableMiB, pressure, load1, busyCores, cores }` now; `busyCores` is the CPU in use since the previous reading (the load average lags by a minute). Pressure is `normal` where the system does not report it. */
export function readMachine() {
  let availableMiB, pressure = 'normal';
  if (process.platform === 'darwin') {
    availableMiB = parseVmStat(run('vm_stat', []));
    pressure = pressureName(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim() || 1);
  } else {
    try { availableMiB = parseMeminfo(readFileSync('/proc/meminfo', 'utf8')); } catch { availableMiB = Infinity; }
  }
  const cores = availableParallelism(), now = cpuTimes();
  const busyCores = busyCoresBetween(lastCpu, now, cores) ?? loadavg()[0];
  lastCpu = now;
  return { availableMiB, pressure, load1: loadavg()[0], busyCores, cores };
}

/**
 * The resident MiB of a process tree, 0 if it is gone, plus, with `alsoMatching`, the processes that match a pattern outside the tree:
 * on macOS the WebKit helper processes of Playwright are started by the system, not by the test run.
 */
export function processTreeMiB(pid, alsoMatching) {
  const table = parseProcessTable(run('ps', ['-axo', 'pid=,ppid=,rss=,command=']));
  const tree = treeMiB(table, pid);
  return tree && alsoMatching ? tree + matchingMiB(table, alsoMatching) : tree;
}
