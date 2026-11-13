// Prepares the fixed data set that switch-timing.mjs measures, on this checkout's local instance.
// Usage, from the checkout root: node .agents/skills/prepare-arc-local/scripts/perf-fixture.mjs
// It creates six Claude Code sessions, shown as "Perf 1" to "Perf 6", with three turns each, three Windows ("Perf A": 1-3,
// "Perf B": 4-6, "Perf C": 2 and 5) and shows Perf A and Perf B as sections in Bot mode. Parts that exist are kept and
// missing views are added, so a second run only completes what is missing. It prints the Windows and sessions as JSON.
import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = process.cwd();
const command = join(root, 'scripts/local/command.mjs');
// The management socket answers session calls and the command line's sign-in answers window calls; neither signs a browser in.
async function controller(...args) {
  try { return JSON.parse((await run(process.execPath, [command, 'controller', ...args], { encoding: 'utf8', timeout: 180_000 })).stdout); }
  catch (error) {
    let code;
    try { code = JSON.parse(error.stdout).error?.code; } catch { code = undefined; }
    throw Object.assign(new Error(`controller ${args.slice(0, 3).join(' ')} failed: ${error.stdout || error.stderr || error.message}`), { code });
  }
}

const topics = ['binary search', 'the TCP handshake', 'CSS grid layout', 'git rebase', 'HTTP caching', 'property-based testing'];
const turns = (topic) => [
  `Explain ${topic} in about 200 words. Use a short bulleted list and one small code block.`,
  `Give three common mistakes with ${topic} and how to avoid each, as a numbered list.`,
  `Summarize ${topic} in two sentences.`,
];
const plans = [
  { title: 'Perf A', sessions: [1, 2, 3], section: true },
  { title: 'Perf B', sessions: [4, 5, 6], section: true },
  { title: 'Perf C', sessions: [2, 5], section: false },
];
const sessionName = (index) => `Perf ${index}`;
const ref = (binding) => ({ hostId: binding.hostId, providerId: binding.providerId, nativeSessionId: binding.nativeSessionId });

async function waitForIdle(address, previous) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const read = await controller('session', 'read', address, '--limit', '1')
      .catch(error => { if (error.code === 'history_unavailable' && Date.now() < deadline) return {}; throw error; });
    const [newest] = read.entries ?? [];
    const state = read.session?.state;
    if (state === 'waiting' || state === 'failed') throw new Error(`Session ${address} is ${state}.`);
    if (newest && newest.id !== previous && newest.role === 'assistant' && state !== 'running') return newest.id;
    if (Date.now() > deadline) throw new Error(`No reply within three minutes in ${address}.`);
    await delay(2000);
  }
}

const listWindows = async () => (await controller('window', 'list')).windows ?? [];
const known = await listWindows();
// The sessions the Perf Windows already show, by the name their views carry.
const placed = new Map();
for (const window of known.filter(item => plans.some(plan => plan.title === item.title))) {
  for (const view of window.views ?? []) if (view.binding && /^Perf \d$/.test(view.binding.title)) placed.set(view.binding.title, ref(view.binding));
}
let listing;
/** Every Claude Code session of the instance, across pages. */
const listSessions = () => listing ??= (async () => {
  const sessions = [];
  let cursor;
  do {
    const page = await controller('session', 'list', '--provider', 'claude', '--limit', '50', ...(cursor ? ['--cursor', cursor] : []));
    sessions.push(...(page.sessions ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return sessions;
})();

async function ensureSession(index) {
  const existing = placed.get(sessionName(index));
  if (existing) return existing;
  const [first, ...rest] = turns(topics[index - 1]);
  // A session that was never placed in a Window is found by its first prompt, which names it until it is renamed.
  let address = (await listSessions()).find(session => session.title?.startsWith(first))?.address;
  if (!address) {
    address = (await controller('session', 'create', '--provider', 'claude', '--message', first)).session.address;
    let last = await waitForIdle(address, undefined);
    for (const prompt of rest) { await controller('session', 'send', address, prompt); last = await waitForIdle(address, last); }
  }
  const [hostId, providerId, nativeSessionId] = address.split('/');
  return { hostId, providerId, nativeSessionId };
}
const sessions = await Promise.all(topics.map((_, index) => ensureSession(index + 1)));

for (const plan of plans) {
  let window = known.find(item => item.title === plan.title);
  if (!window) {
    const result = await controller('window', 'create', '--title', plan.title);
    window = { ...(result.window ?? result), views: [] };
  }
  const shown = new Set((window.views ?? []).flatMap(view => view.binding ? [view.binding.title] : []));
  let hasPrimary = (window.views ?? []).some(view => view.placement === 'primary' && view.binding);
  for (const index of plan.sessions) {
    if (shown.has(sessionName(index))) continue;
    await controller('window', 'view', 'create', window.id, '--mode', hasPrimary ? 'dock' : 'primary',
      '--session', JSON.stringify({ ...sessions[index - 1], title: sessionName(index) }));
    hasPrimary = true;
  }
}
// Every Window must show exactly its planned sessions; a partial one would be measured with fewer views.
const windows = [];
for (const window of await listWindows()) {
  const plan = plans.find(item => item.title === window.title);
  if (!plan) continue;
  const titles = (window.views ?? []).flatMap(view => view.binding ? [view.binding.title] : []).sort();
  const expected = plan.sessions.map(sessionName).sort();
  if (JSON.stringify(titles) !== JSON.stringify(expected)) throw new Error(`${plan.title} shows ${titles.join(', ') || 'no session'} instead of ${expected.join(', ')}.`);
  windows.push({ ...plan, id: window.id });
}
if (windows.length !== plans.length) throw new Error(`Expected ${plans.length} Perf Windows, found ${windows.length}.`);

// Bot mode sections are a page action: the Window's menu offers "Show as section".
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    for (const plan of windows.filter(item => item.section)) {
      await page.goto(`${origin}/?mode=window&window=${encodeURIComponent(plan.id)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const toolbar = page.locator('header.lab-window-toolbar');
      await toolbar.getByRole('heading', { name: plan.title, exact: true }).waitFor({ timeout: 30_000 });
      await toolbar.getByRole('button', { name: 'Window actions', exact: true }).click();
      const menu = page.getByRole('menu', { name: 'Window actions', exact: true });
      const show = menu.getByRole('menuitem', { name: 'Show as section', exact: true });
      if (await show.count() && await show.isEnabled()) {
        await show.click();
        await page.getByText('Shown as a section in Bot mode.').waitFor({ timeout: 15_000 });
      } else await page.keyboard.press('Escape');
    }
  } finally {
    for (const open of context.pages()) await open.close().catch(() => {});
    await context.request.post(origin + '/auth/logout', { headers: { origin, 'content-type': 'application/json' }, data: '{}', timeout: 10_000 }).catch(() => {});
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ windows: windows.map(({ title, id, sessions: members }) => ({ title, id, sessions: members.map(sessionName) })),
  sessions: sessions.map((session, index) => ({ name: sessionName(index + 1), address: [session.hostId, session.providerId, session.nativeSessionId].join('/') })) }, null, 2));
