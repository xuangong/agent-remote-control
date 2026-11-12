// Times Window switches and bot switches on this checkout's local instance, with the data set of perf-fixture.mjs.
// Usage, from the checkout root:
//   node .agents/skills/prepare-arc-local/scripts/switch-timing.mjs [--throttle N] [--rounds N] [--out FILE]
// Each switch is timed in the page, from the click to the moment the target shows its own conversations: every view of
// the Window (or the bot's conversation) with its first request and all three replies. Long tasks (over 50 ms) that
// start in that span are counted. The first visit to each target is reported apart from the measured rounds, since it
// also connects the sessions. --throttle slows the CPU N times (Chromium's emulation); the default is 1.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, index, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[index + 1]]] : pairs, []));
const throttle = Number(options.throttle ?? 1), rounds = Number(options.rounds ?? 3);
const root = process.cwd();
const topics = ['binary search', 'the TCP handshake', 'CSS grid layout', 'git rebase', 'HTTP caching', 'property-based testing'];
const controller = (...args) => JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/local/command.mjs'), 'controller', ...args], { encoding: 'utf8', timeout: 60_000 }));
const { windows: catalog = [] } = controller('window', 'list');
const windows = ['Perf A', 'Perf B', 'Perf C'].map(title => {
  const window = catalog.find(item => item.title === title);
  if (!window) throw new Error(`${title} is missing: run perf-fixture.mjs first.`);
  const sessions = window.views.filter(view => view.binding).map(view => Number(view.binding.title.replace('Perf ', '')));
  return { title, id: window.id, topics: sessions.map(index => topics[index - 1]) };
});
const bots = topics.map((topic, index) => ({ title: `Perf ${index + 1}`, topic }));

const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');

/** In the page: click, then wait frame by frame until the target is complete; return the span and its long tasks. */
async function timeSwitch(page, kind, target) {
  return page.evaluate(async ({ kind, target }) => {
    const shown = element => !!element && element.getBoundingClientRect().width > 0 && getComputedStyle(element).visibility !== 'hidden';
    const complete = pane => pane.querySelectorAll('.agent-message-assistant').length >= 3;
    const done = kind === 'window'
      ? () => document.querySelector('header.lab-window-toolbar h2')?.textContent === target.title && target.topics.every(topic =>
        [...document.querySelectorAll('#lab-workbench .lab-session-family-pane[data-view-id]')].some(pane => shown(pane) && complete(pane)
          && pane.querySelector('.agent-message-user, .agent-outgoing-message')?.textContent?.includes(`Explain ${topic}`)))
      : () => {
        const conversation = document.querySelector('.lab-bot-conversation');
        return conversation?.querySelector('.ui-toolbar-title')?.textContent === target.title
          && [...conversation.querySelectorAll('.lab-session-conversation-host')].some(pane => shown(pane) && complete(pane)
            && pane.querySelector('.agent-message-user, .agent-outgoing-message')?.textContent?.includes(`Explain ${target.topic}`));
      };
    const button = kind === 'window'
      ? document.querySelector(`#lab-context button.lab-window-open[data-window-id="${target.id}"]`)
      : document.querySelector(`nav[aria-label="Bots"] button[aria-label="${target.title}"]`);
    if (!button) throw new Error(`No control opens ${target.title}.`);
    const start = performance.now();
    button.click();
    const deadline = start + 30_000;
    while (!done()) {
      if (performance.now() > deadline) throw new Error(`${target.title} did not finish within 30 s.`);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const end = performance.now();
    // Let a long task that is still running be reported.
    await new Promise(resolve => setTimeout(resolve, 100));
    const tasks = window.__longTasks.filter(task => task.startTime >= start && task.startTime <= end);
    return { target: target.title, ms: Math.round(end - start), longTasks: tasks.length,
      longTaskMs: Math.round(tasks.reduce((sum, task) => sum + task.duration, 0)), longestTaskMs: Math.round(Math.max(0, ...tasks.map(task => task.duration))) };
  }, { kind, target });
}

function summary(results) {
  const sorted = results.map(result => result.ms).sort((a, b) => a - b), at = share => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
  return { switches: results.length, medianMs: at(0.5), p90Ms: at(0.9), maxMs: sorted.at(-1),
    longTasks: results.reduce((sum, result) => sum + result.longTasks, 0), longTaskMs: results.reduce((sum, result) => sum + result.longTaskMs, 0),
    longestTaskMs: Math.max(0, ...results.map(result => result.longestTaskMs)) };
}

async function measure(page, kind, targets, url, ready) {
  await page.goto(origin + url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator(ready).first().waitFor({ timeout: 30_000 });
  // The first visit to each target connects its sessions; it is reported apart. Start from the last target so that the first click switches.
  const firstVisits = [];
  for (const target of targets) firstVisits.push(await timeSwitch(page, kind, target));
  const measured = [];
  for (let round = 0; round < rounds; round++) for (const target of targets) measured.push(await timeSwitch(page, kind, target));
  return { firstVisits, switches: measured, summary: summary(measured) };
}

const browser = await chromium.launch({ headless: true });
let report;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    await context.addInitScript(() => {
      window.__longTasks = [];
      new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__longTasks.push({ startTime: entry.startTime, duration: entry.duration }); })
        .observe({ type: 'longtask', buffered: true });
    });
    const page = await context.newPage();
    if (throttle > 1) await (await context.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
    const windowResult = await measure(page, 'window', [...windows.slice(1), windows[0]], `/?mode=window&window=${encodeURIComponent(windows[0].id)}`, '#lab-context button.lab-window-open');
    const botResult = await measure(page, 'bot', bots, '/?mode=bot', 'nav[aria-label="Bots"] button.lab-bot-row');
    report = { commit, date: new Date().toISOString(), viewport: '1440x900', throttle, rounds, window: windowResult, bot: botResult };
  } finally {
    for (const open of context.pages()) await open.close().catch(() => {});
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
const out = options.out ?? join(root, '.tmp/perf', `switch-${commit}-x${throttle}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ out, window: report.window.summary, bot: report.bot.summary }, null, 2));
