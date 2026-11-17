// What a view of a journal-served session shows and costs while control comes from the Relay (S5), on the `pnpm local` instance.
// Run from the repository root while the instance runs, with its journals on and smart reading on for Copilot:
//   node packages/agent-remote-lab/performance/session-control.mjs --label s5 --out .tmp/s5-control.json
// Options: --opens N (default 30)  --sends N (pages that send twice, default 4)  --rtt MS  --throttle N  --label TEXT  --out FILE
// Per open it records the visible status labels (those that name Restoring or Checking access), the Controller streams the Relay opened
// before anything was sent, and the time from the socket's `negotiated` frame to a composer that accepts text. Per send it records the
// time until the page shows the message as sending, and until the Controller acknowledged it, for the first send of a view (when the
// Relay has no Controller stream yet) and the second (when it has one). The model turns are real; they use one tiny prompt.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startLatencyProxy } from './latency-proxy.mjs';

const root = process.cwd();
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
const opens = Number(options.opens ?? 30), sends = Number(options.sends ?? 4), rttMs = Number(options.rtt ?? 0), throttle = Number(options.throttle ?? 1);
const outFile = resolve(options.out ?? '.tmp/session-control.json');
const controller = (...args) => JSON.parse(execFileSync('agent-remote-controller-dev', args, { cwd: root, encoding: 'utf8', timeout: 180_000 }));
const directOrigin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const proxy = rttMs > 0 ? await startLatencyProxy({ target: directOrigin, rttMs }) : undefined;
const origin = proxy?.origin ?? directOrigin;
const session = controller('session', 'list', '--limit', '50').sessions.find(item => item.providerId === 'copilot');
if (!session) throw new Error('The instance has no Copilot session of its own; create one with a real model turn first.');
const url = controller('session', 'link', session.address).url.replace(directOrigin, origin);
const sessionKey = `copilot:${session.address.split('/').at(-1)}`;
const { chromium } = createRequire(join(root, 'packages/agent-remote-lab/package.json'))('@playwright/test');

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null; };
const summary = values => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null });
async function waitIdle() {
  for (const deadline = Date.now() + 120_000; Date.now() < deadline; await delay(1500)) if (controller('session', 'read', session.address, '--limit', '0').session?.state === 'idle') return;
  throw new Error('The session did not become idle.');
}

const observer = `(() => {
  const seen = []; let last = '';
  const read = () => {
    const input = document.querySelector('[data-testid="prompt-input"]');
    const labels = [...document.querySelectorAll('.lab-conversation-status, .lab-session-control-owner, .lab-empty-state h3')].map(node => node.textContent.trim()).filter(Boolean);
    const enabled = !!input && input.getAttribute('aria-disabled') !== 'true' && !input.hasAttribute('readonly') && !input.hasAttribute('disabled') && input.getAttribute('contenteditable') !== 'false';
    const key = JSON.stringify([labels, enabled]);
    if (key !== last) { last = key; seen.push({ t: Date.now(), labels, enabled, sending: document.querySelectorAll('[data-delivery-state], [data-testid="pending-send"]').length }); }
  };
  new MutationObserver(read).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  window.__seen = seen; read();
})()`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const result = { label: options.label ?? null, origin, rttMs, throttle, session: session.address, startedAt: new Date().toISOString(), build: controller('--build-info'), opens: [], sends: [] };
const save = () => { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, JSON.stringify(result, null, 2)); };

async function page() {
  const handle = await context.newPage();
  handle.setDefaultTimeout(30_000);
  const cdp = await context.newCDPSession(handle);
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const frames = [];
  handle.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const outer = JSON.parse(String(frame.payload));
      // Session views share one channel socket, which wraps each session frame.
      const message = outer.type === 'message' && outer.message ? outer.message : outer;
      frames.push({ t: Date.now(), type: message.type, access: message.payload?.access, requestId: message.payload?.requestId, command: message.payload?.command });
    } catch { /* not a protocol frame */ }
  }));
  await handle.addInitScript(observer);
  return { handle, frames };
}
const enabledAt = (seen, from) => seen.find(state => state.t >= from && state.enabled && state.labels.some(label => label === 'Ready'))?.t;

// ---- opens ----
const startedAt = Date.now();
for (let index = 0; index < opens; index++) {
  const { handle, frames } = await page();
  const start = Date.now();
  await handle.goto(url, { waitUntil: 'domcontentloaded' });
  await handle.waitForFunction(() => window.__seen?.some(state => state.enabled && state.labels.includes('Ready')), undefined, { timeout: 30_000 });
  await delay(800);
  const seen = await handle.evaluate(() => window.__seen);
  const negotiated = frames.find(frame => frame.type === 'negotiated')?.t;
  const composerAt = enabledAt(seen, start);
  const granted = frames.find(frame => frame.type === 'session_control' && frame.access === 'control')?.t;
  result.opens.push({ start, readyMs: composerAt === undefined ? null : composerAt - start, negotiatedToComposerMs: negotiated !== undefined && composerAt !== undefined ? composerAt - negotiated : null,
    negotiatedToGrantMs: negotiated !== undefined && granted !== undefined ? granted - negotiated : null,
    namesRestoring: seen.some(state => state.labels.some(label => /Restoring/.test(label))), namesCheckingAccess: seen.some(state => state.labels.some(label => /Checking access/.test(label))) });
  await handle.close();
  await delay(700);
  save();
}

// ---- sends: the first send of a view, then a second on the same view ----
for (let index = 0; index < sends; index++) {
  const { handle, frames } = await page();
  await handle.goto(url, { waitUntil: 'domcontentloaded' });
  await handle.waitForFunction(() => window.__seen?.some(state => state.enabled && state.labels.includes('Ready')), undefined, { timeout: 30_000 });
  await delay(800);
  const input = handle.getByRole('textbox', { name: 'Message', exact: true });
  for (const ordinal of ['first', 'second']) {
    const requestsBefore = frames.length;
    const t0 = Date.now();
    await input.fill('Reply with the single word OK.');
    const pressed = Date.now();
    await input.press('Enter');
    const acknowledged = await handle.waitForFunction(() => true, undefined, { timeout: 30_000 }).then(() => undefined);
    void acknowledged;
    let ackAt;
    for (const deadline = Date.now() + 30_000; Date.now() < deadline && ackAt === undefined; await delay(20)) ackAt = frames.slice(requestsBefore).find(frame => frame.type === 'command_acknowledged')?.t;
    const seen = await handle.evaluate(() => window.__seen);
    const sendingAt = seen.find(state => state.t >= pressed && state.sending > 0)?.t;
    result.sends.push({ ordinal, sendingMs: sendingAt === undefined ? null : sendingAt - pressed, acknowledgedMs: ackAt === undefined ? null : ackAt - pressed, fillMs: pressed - t0 });
    await waitIdle();
    await delay(1000);
    save();
  }
  await handle.close();
}

// ---- Relay side: the Controller streams opened while a view only read, from the Relay's own diagnostics ----
await delay(4000);
const relay = controller('diagnostics', '--source', 'server', '--since', new Date(startedAt - 1000).toISOString(), '--limit', '1000').server ?? [];
const openingEvents = relay.filter(entry => entry.event === 'stream_opening').map(entry => Date.parse(entry.timestamp ?? entry.at ?? '') || entry.t).filter(Number.isFinite);
const readOnlyWindow = result.opens.map(sample => [sample.start - 500, sample.start + (sample.readyMs ?? 0) + 800]);
result.relayStreamOpeningsDuringReadOnlyOpens = openingEvents.filter(time => readOnlyWindow.some(([from, to]) => time >= from && time <= to)).length;
result.relayStreamOpeningsTotal = openingEvents.length;
result.summary = {
  opens: opens, namesRestoring: result.opens.filter(sample => sample.namesRestoring).length, namesCheckingAccess: result.opens.filter(sample => sample.namesCheckingAccess).length,
  readyMs: summary(result.opens.map(sample => sample.readyMs).filter(Number.isFinite)), negotiatedToComposerMs: summary(result.opens.map(sample => sample.negotiatedToComposerMs).filter(Number.isFinite)),
  negotiatedToGrantMs: summary(result.opens.map(sample => sample.negotiatedToGrantMs).filter(Number.isFinite)),
  firstSend: { sendingMs: summary(result.sends.filter(send => send.ordinal === 'first').map(send => send.sendingMs).filter(Number.isFinite)), acknowledgedMs: summary(result.sends.filter(send => send.ordinal === 'first').map(send => send.acknowledgedMs).filter(Number.isFinite)) },
  secondSend: { sendingMs: summary(result.sends.filter(send => send.ordinal === 'second').map(send => send.sendingMs).filter(Number.isFinite)), acknowledgedMs: summary(result.sends.filter(send => send.ordinal === 'second').map(send => send.acknowledgedMs).filter(Number.isFinite)) },
};
if (proxy) result.proxy = { ...proxy.counts };
save();
await browser.close();
await proxy?.close();
console.log(JSON.stringify(result.summary, null, 2));
console.log('relayStreamOpeningsDuringReadOnlyOpens', result.relayStreamOpeningsDuringReadOnlyOpens, 'total', result.relayStreamOpeningsTotal);
