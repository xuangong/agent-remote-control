// What a view of a journal-served session shows and costs while control comes from the Relay (S5), on the `pnpm local` instance.
// Run from the repository root while the instance runs, with its journals on and smart reading on for Copilot:
//   node packages/agent-remote-lab/performance/session-control.mjs --label s5 --out .tmp/s5-control.json
// Options: --opens N (default 30)  --sends N (pages that send twice, default 4)  --rtt MS  --throttle N  --label TEXT  --out FILE
//          --session ADDRESS (a Copilot session of the instance; default the most recent)
//          --type-during-open (each open types a message as soon as the editor is editable and presses Enter)
// Per open it records the T5 connection words any status frame showed (`connectionWords`, from agent-e2e's one list), the Controller
// streams the Relay opened before anything was sent, and the time from the socket's `negotiated` frame to a composer that accepts text.
// With --type-during-open it also records, from the Enter key press: the first sending mark (`sendingMs`), the Controller's
// acknowledgement (`acknowledgedMs`) and the user row in the timeline (`deliveredMs`), and whether the editor kept focus and the text
// typed after Enter. Per send it records the time until the page shows the message as sending, and until the Controller acknowledged
// it, for the first send of a view (when the Relay has no Controller stream yet) and the second (when it has one). The model turns are
// real; they use one tiny prompt.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SESSION_CONNECTION_WORDS } from '@orchardworks/agent-e2e/faults/connection-words.mjs';
import { startLatencyProxy } from '@orchardworks/agent-e2e/faults/latency-proxy.mjs';

const root = process.cwd();
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) options[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];
const opens = Number(options.opens ?? 30), sends = Number(options.sends ?? 4), rttMs = Number(options.rtt ?? 0), throttle = Number(options.throttle ?? 1);
const typeDuringOpen = options['type-during-open'] === 'true';
const PROMPT = 'Reply with the single word OK.';
const runId = Date.now().toString(36);
const outFile = resolve(options.out ?? '.tmp/session-control.json');
const controller = (...args) => JSON.parse(execFileSync('agent-remote-controller-dev', args, { cwd: root, encoding: 'utf8', timeout: 180_000 }));
const directOrigin = options.origin ?? JSON.parse(execFileSync('pnpm', ['--silent', 'local', 'status', '--json'], { cwd: root, encoding: 'utf8' })).origin;
const proxy = rttMs > 0 ? await startLatencyProxy({ target: directOrigin, rttMs }) : undefined;
const origin = proxy?.origin ?? directOrigin;
const copilotSessions = controller('session', 'list', '--provider', 'copilot', '--limit', '50').sessions;
const session = options.session ? copilotSessions.find(item => item.address === options.session) : copilotSessions[0];
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

// Status frames: every element that may carry a per-session label. The pane's are read inside the selected primary group (the link's
// session; a Window may dock other sessions beside it), the page's anywhere. Words are read from these and from the pane's composer.
const PANE = '.lab-primary-group[data-selected]';
const PANE_STATUS = ".lab-conversation-status, [data-testid='agent-activity-label'], .lab-session-control-owner, .lab-empty-state h3, .lab-control-note";
const PAGE_STATUS = '.lab-toast, .lab-connection-status, .gateway-recovery';
const observer = `(() => {
  const WORDS = ${JSON.stringify(SESSION_CONNECTION_WORDS)}.map(word => [word, new RegExp('\\\\b' + word.toLowerCase() + '\\\\b')]);
  const seen = []; let last = '';
  window.__marker = undefined; window.__enterAt = undefined;
  const editable = input => !!input && input.getAttribute('aria-disabled') !== 'true' && !input.hasAttribute('readonly') && !input.hasAttribute('disabled') && input.getAttribute('contenteditable') !== 'false';
  const texts = (root, selector) => [...root.querySelectorAll(selector)].map(node => node.textContent.trim()).filter(Boolean);
  const read = () => {
    const pane = document.querySelector(${JSON.stringify(PANE)}) ?? document;
    const input = pane.querySelector('[data-testid="prompt-input"]');
    const labels = [...texts(pane, ${JSON.stringify(PANE_STATUS)}), ...texts(document, ${JSON.stringify(PAGE_STATUS)})];
    const text = [...labels, ...texts(pane, '.agent-composer')].join(' \\n ').toLowerCase();
    const words = WORDS.filter(([, pattern]) => pattern.test(text)).map(([word]) => word);
    const marker = window.__marker;
    const delivered = !!marker && [...pane.querySelectorAll('.agent-timeline-entry:not(.agent-outgoing-message) .agent-message-user')].some(node => node.textContent.includes(marker));
    const state = { labels, words, composer: !!input, enabled: editable(input), inPane: pane !== document, sending: pane.querySelectorAll('[data-delivery-state], [data-testid="pending-send"]').length, delivered };
    const key = JSON.stringify(state);
    if (key !== last) { last = key; seen.push({ t: Date.now(), ...state }); }
  };
  document.addEventListener('keydown', event => { if (event.key === 'Enter' && window.__marker && window.__enterAt === undefined) window.__enterAt = Date.now(); }, true);
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
const promptInput = handle => handle.locator(PANE).getByRole('textbox', { name: 'Message', exact: true });
const enabledAt = (seen, from) => seen.find(state => state.t >= from && state.enabled && state.labels.some(label => label === 'Ready'))?.t;

const sinceStart = (at, from) => at === undefined || from === undefined ? null : at - from;
const opening = seen => ({ connectionWords: [...new Set(seen.flatMap(state => state.words))], composerEditableAtFirstPaint: seen.find(state => state.composer)?.enabled ?? null });

// ---- opens ----
const startedAt = Date.now();
for (let index = 0; index < opens; index++) {
  const { handle, frames } = await page();
  const start = Date.now();
  await handle.goto(url, { waitUntil: 'domcontentloaded' });
  let typed = {};
  if (typeDuringOpen) {
    // The open's ordinal marks its row, so the delivered row is told apart from the history's identical prompts.
    const marker = `${PROMPT} (${result.label ?? 'open'} ${runId}-${index + 1})`;
    // The link's session lives in the Window's selected primary group; the shell painted before the Window loads is replaced.
    await handle.waitForFunction(() => window.__seen?.some(state => state.enabled && state.inPane), undefined, { timeout: 30_000 });
    const editableAt = (await handle.evaluate(() => window.__seen)).find(state => state.enabled && state.inPane)?.t;
    const input = promptInput(handle);
    await handle.evaluate(text => { window.__marker = text; }, marker);
    await input.fill(marker);
    const framesBefore = frames.length;
    await input.press('Enter');
    await delay(50);
    const focusKept = await handle.evaluate(() => !!document.activeElement?.closest('[data-testid="prompt-input"]'));
    await handle.keyboard.type(' next');
    const textKept = (await input.textContent())?.includes('next') ?? false;
    // A composer that refuses the key while the session opens shows no sending mark: nothing was sent, and the open records it.
    const accepted = await handle.waitForFunction(() => window.__seen?.some(state => window.__enterAt !== undefined && state.t >= window.__enterAt && (state.sending > 0 || state.delivered)), undefined, { timeout: 5000 }).then(() => true, () => false);
    if (accepted) await handle.waitForFunction(() => window.__seen?.some(state => state.delivered), undefined, { timeout: 120_000 }).catch(() => undefined);
    let ackAt;
    for (const deadline = Date.now() + (accepted ? 30_000 : 0); Date.now() < deadline && ackAt === undefined; await delay(20)) ackAt = frames.slice(framesBefore).find(frame => frame.type === 'command_acknowledged')?.t;
    const enterAt = await handle.evaluate(() => window.__enterAt);
    const seen = await handle.evaluate(() => window.__seen);
    typed = { editableMs: sinceStart(editableAt, start), sendingMs: sinceStart(seen.find(state => state.t >= enterAt && state.sending > 0)?.t, enterAt),
      acknowledgedMs: sinceStart(ackAt, enterAt), deliveredMs: sinceStart(seen.find(state => state.delivered)?.t, enterAt), enterRefused: !accepted, focusKept, textKept };
    await input.fill('');
    await waitIdle();
  } else {
    await handle.waitForFunction(() => window.__seen?.some(state => state.enabled && state.labels.includes('Ready')), undefined, { timeout: 30_000 });
  }
  await delay(800);
  const seen = await handle.evaluate(() => window.__seen);
  const negotiated = frames.find(frame => frame.type === 'negotiated')?.t;
  const composerAt = enabledAt(seen, start);
  const granted = frames.find(frame => frame.type === 'session_control' && frame.access === 'control')?.t;
  result.opens.push({ start, readyMs: composerAt === undefined ? null : composerAt - start, negotiatedToComposerMs: negotiated !== undefined && composerAt !== undefined ? composerAt - negotiated : null,
    negotiatedToGrantMs: negotiated !== undefined && granted !== undefined ? granted - negotiated : null, ...opening(seen), ...typed,
    states: seen.map(({ t, ...state }) => ({ ms: t - start, ...state })) });
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
  const input = promptInput(handle);
  for (const ordinal of ['first', 'second']) {
    const requestsBefore = frames.length;
    const t0 = Date.now();
    await input.fill('Reply with the single word OK.');
    const pressed = Date.now();
    await input.press('Enter');
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
// A typed open sends, so only opens that only read count here.
const readOnlyWindow = typeDuringOpen ? [] : result.opens.map(sample => [sample.start - 500, sample.start + (sample.readyMs ?? 0) + 800]);
result.relayStreamOpeningsDuringReadOnlyOpens = openingEvents.filter(time => readOnlyWindow.some(([from, to]) => time >= from && time <= to)).length;
result.relayStreamOpeningsTotal = openingEvents.length;
result.summary = {
  opens: opens, opensWithConnectionWords: result.opens.filter(sample => sample.connectionWords.length > 0).length,
  connectionWords: Object.fromEntries(SESSION_CONNECTION_WORDS.map(word => [word, result.opens.filter(sample => sample.connectionWords.includes(word)).length]).filter(([, count]) => count > 0)),
  opensNotEditableAtFirstPaint: result.opens.filter(sample => sample.composerEditableAtFirstPaint === false).length,
  readyMs: summary(result.opens.map(sample => sample.readyMs).filter(Number.isFinite)), negotiatedToComposerMs: summary(result.opens.map(sample => sample.negotiatedToComposerMs).filter(Number.isFinite)),
  negotiatedToGrantMs: summary(result.opens.map(sample => sample.negotiatedToGrantMs).filter(Number.isFinite)),
  firstSend: { sendingMs: summary(result.sends.filter(send => send.ordinal === 'first').map(send => send.sendingMs).filter(Number.isFinite)), acknowledgedMs: summary(result.sends.filter(send => send.ordinal === 'first').map(send => send.acknowledgedMs).filter(Number.isFinite)) },
  ...(typeDuringOpen ? { typedDuringOpen: {
    editableMs: summary(result.opens.map(sample => sample.editableMs).filter(Number.isFinite)), sendingMs: summary(result.opens.map(sample => sample.sendingMs).filter(Number.isFinite)),
    acknowledgedMs: summary(result.opens.map(sample => sample.acknowledgedMs).filter(Number.isFinite)), deliveredMs: summary(result.opens.map(sample => sample.deliveredMs).filter(Number.isFinite)),
    enterRefused: result.opens.filter(sample => sample.enterRefused).length, focusKept: result.opens.filter(sample => sample.focusKept).length, textKept: result.opens.filter(sample => sample.textKept).length } } : {}),
  secondSend: { sendingMs: summary(result.sends.filter(send => send.ordinal === 'second').map(send => send.sendingMs).filter(Number.isFinite)), acknowledgedMs: summary(result.sends.filter(send => send.ordinal === 'second').map(send => send.acknowledgedMs).filter(Number.isFinite)) },
};
if (proxy) result.proxy = { ...proxy.counts };
save();
await browser.close();
await proxy?.close();
console.log(JSON.stringify(result.summary, null, 2));
console.log('relayStreamOpeningsDuringReadOnlyOpens', result.relayStreamOpeningsDuringReadOnlyOpens, 'total', result.relayStreamOpeningsTotal);
