// Prepares the fixed data set that switch-timing.mjs measures, on this checkout's local instance.
// Usage, from the checkout root: node .agents/skills/prepare-arc-local/scripts/perf-fixture.mjs
// It creates six Claude Code sessions, shown as "Perf 1" to "Perf 6", with three turns each, three Windows ("Perf A": 1-3,
// "Perf B": 4-6, "Perf C": 2 and 5) and shows Perf A and Perf B as sections in Bot mode. Parts that exist are kept,
// so a second run only completes what is missing. It prints the Windows and sessions as JSON.
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
const windows = [
  { title: 'Perf A', sessions: [1, 2, 3], section: true },
  { title: 'Perf B', sessions: [4, 5, 6], section: true },
  { title: 'Perf C', sessions: [2, 5], section: false },
];

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

async function ensureSession(index, existing) {
  const title = `Perf ${index}`;
  const [first, ...rest] = turns(topics[index - 1]);
  // A session is named after its first prompt.
  let address = existing.find(session => session.providerId === 'claude' && session.title?.startsWith(first))?.address;
  if (!address) {
    address = (await controller('session', 'create', '--provider', 'claude', '--message', first)).session.address;
    let last = await waitForIdle(address, undefined);
    for (const prompt of rest) { await controller('session', 'send', address, prompt); last = await waitForIdle(address, last); }
  }
  const [hostId, providerId, nativeSessionId] = address.split('/');
  // The Window views carry the name; Bot mode shows a bot by its view's title.
  return { hostId, providerId, nativeSessionId, title, address };
}

const listed = await controller('session', 'list', '--provider', 'claude', '--limit', '50');
const existing = (listed.sessions ?? []).map(session => {
  const address = session.address ?? [session.hostId, session.providerId, session.nativeSessionId].join('/');
  const [hostId, providerId, nativeSessionId] = address.split('/');
  return { hostId, providerId, nativeSessionId, title: session.title, address };
});
const sessions = await Promise.all(topics.map((_, index) => ensureSession(index + 1, existing)));

const known = (await controller('window', 'list')).windows ?? [];
const created = [];
for (const plan of windows) {
  let window = known.find(item => item.title === plan.title);
  if (!window) {
    const result = await controller('window', 'create', '--title', plan.title);
    window = result.window ?? result;
    for (const [order, index] of plan.sessions.entries()) {
      const session = sessions[index - 1];
      await controller('window', 'view', 'create', window.id, '--mode', order === 0 ? 'primary' : 'dock',
        '--session', JSON.stringify({ hostId: session.hostId, providerId: session.providerId, nativeSessionId: session.nativeSessionId, title: session.title }));
    }
  }
  created.push({ ...plan, id: window.id });
}

// Bot mode sections are a page action: the Window's menu offers "Show as section".
const { origin } = JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' }));
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await context.newPage();
    for (const plan of created.filter(item => item.section)) {
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
console.log(JSON.stringify({ windows: created.map(({ title, id, sessions: members }) => ({ title, id, sessions: members.map(index => `Perf ${index}`) })), sessions }, null, 2));
