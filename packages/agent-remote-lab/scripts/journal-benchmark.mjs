import { mkdtemp, rm, stat } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHostJournals } from '@orchardworks/agent-remote-hosted';
import { SessionJournal } from '@orchardworks/agent-remote-journal';
import { SqlJournalStore } from '@orchardworks/agent-remote-journal-sqlite';
import { openNodeJournalDatabase } from '@orchardworks/agent-remote-journal-sqlite/node';

/**
 * Measures the journal service as the Relay runs it: `createHostJournals` over `SqlJournalStore` over `node:sqlite`.
 * The binding is synchronous, so what matters is how long one call holds the event loop. Every figure is milliseconds.
 * `limit` figures decide whether the binding is good enough; the others are reported so the owner can judge them.
 */
const DEADLINE_MS = Number(process.env.JOURNAL_BENCHMARK_DEADLINE_MS ?? 270_000);
const HOST = 'host-1';
const PUBLISHER = 'controller-1';
const OPEN = { maxIndexItems: 1_000_000, pageItems: 2000 };
const INDEX_PAGE_ITEMS = 2000;
const BATCH_ITEMS = 128;
const SMALL_BATCH_ITEMS = 4;
const RETAIN = { turns: 50, minItems: 200 };
const LIVE_ONLY_EVERY = 66;
const SESSION_ITEM_MAX = 100_000;
const WORST_CASE = { limits: { sessionBytes: 2 ** 30, hostBytes: 2 ** 40 }, retention: { turns: 1_000_000 } };

const deadline = setTimeout(() => { console.error(`The benchmark passed its ${DEADLINE_MS} ms deadline.`); process.exit(2); }, DEADLINE_MS);
deadline.unref();

// Text pools: ASCII prose and logs, and Chinese prose, sliced at item-specific offsets so rows differ and are reproducible.
let seed = 12345;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
const WORDS = ['request', 'response', 'session', 'journal', 'timeline', 'controller', 'provider', 'error', 'warning', 'build', 'passed', 'failed', 'src/index.ts', 'packages/hosted', 'const', 'return', 'await', 'import', 'export', 'Promise', 'undefined', '12:04:33', '200 OK', 'retrying', 'done'];
const ASCII_POOL = Array.from({ length: 60_000 }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
const HAN = Array.from({ length: 800 }, () => String.fromCodePoint(0x4e00 + Math.floor(random() * 0x51a5)));
const CHINESE_POOL = Array.from({ length: 60_000 }, () => HAN[Math.floor(random() * HAN.length)]).join('');
const slice = (pool, n, length) => { const start = (n * 7919) % (pool.length - length); return pool.slice(start, start + length); };

/** One turn is five items: the ask, an answer, a long command output, a Chinese tool output, and a Chinese answer. */
const KINDS = 5;
const LIGHT_BODY = 'x'.repeat(200);
const TWO_KIB_BODY = 'x'.repeat(2048);

function realisticRow(n) {
  const base = { itemKey: `item-${n}`, providerId: 'codex', sourceKey: `item-${n}:0`, occurredAt: 1_725_000_000_000 + n, turnId: `turn-${Math.floor(n / KINDS)}` };
  switch (n % KINDS) {
    case 0: return { ...base, item: { type: 'user_message', text: n % 20 === 0 ? slice(CHINESE_POOL, n, 120) : slice(ASCII_POOL, n, 300), messageId: base.itemKey } };
    case 1: return { ...base, item: { type: 'assistant_message', text: slice(ASCII_POOL, n, 3000), messageId: base.itemKey } };
    case 2: return { ...base, item: { type: 'tool_call', callId: `call-${n}`, name: 'shell', status: 'completed', error: null, detail: { type: 'shell', command: `grep -rn "journal" packages/ | head -${n % 500}`, cwd: '/work/project' },
      result: { content: [{ type: 'text', stream: 'stdout', text: slice(ASCII_POOL, n, 20_000 + (n % 7) * 5000) }], exitCode: 0, durationMs: 1234 } } };
    case 3: return { ...base, item: { type: 'tool_call', callId: `call-${n}`, name: 'read_file', status: 'completed', error: null, detail: { type: 'shell', command: `cat docs/${n}.md` },
      result: { content: [{ type: 'text', stream: 'stdout', text: `${slice(CHINESE_POOL, n, 5000)}\n${slice(ASCII_POOL, n, 3000)}` }], exitCode: 0 } } };
    default: return { ...base, item: { type: 'assistant_message', text: `${slice(CHINESE_POOL, n, 1200)} ${slice(ASCII_POOL, n, 300)}`, messageId: base.itemKey } };
  }
}
function bodyRow(text) {
  return n => ({ itemKey: `item-${n}`, providerId: 'codex', sourceKey: `item-${n}:0`, occurredAt: 1_725_000_000_000 + n, turnId: `turn-${Math.floor(n / KINDS)}`, item: { type: 'assistant_message', text, messageId: `item-${n}` } });
}
const SHAPES = { realistic: realisticRow, light: bodyRow(LIGHT_BODY), twoKiB: bodyRow(TWO_KIB_BODY) };
/** Every 66th item cannot be reread from native history, as with Controller-side notices. */
const isLiveOnly = n => n % LIVE_ONLY_EVERY === 7;
const digestOf = n => `digest-${n}`;

function entriesFor(shape, first, count, nextSequence, options = {}) {
  const entries = [];
  for (let n = first; n < first + count; n++) {
    const row = SHAPES[shape](n);
    if (options.liveOnly && isLiveOnly(n)) {
      entries.push({ sequence: nextSequence(), op: 'append', row: { ...row, liveOnly: true } });
      entries.push({ sequence: nextSequence(), op: 'seal', itemKey: row.itemKey });
    } else {
      entries.push({ sequence: nextSequence(), op: 'append', row });
      entries.push({ sequence: nextSequence(), op: 'complete', itemKey: row.itemKey, digest: digestOf(n) });
    }
  }
  return entries;
}

async function timed(work) {
  const start = performance.now();
  const value = await work();
  return { ms: performance.now() - start, value };
}
const percentile = (values, fraction) => [...values].sort((left, right) => left - right)[Math.min(values.length - 1, Math.floor(values.length * fraction))];
const summary = values => ({ n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) });

const directory = await mkdtemp(join(tmpdir(), 'arc-journal-benchmark-'));
const database = await openNodeJournalDatabase(join(directory, 'journals.sqlite'));
const store = new SqlJournalStore(database);
const service = extra => createHostJournals({ store, now: Date.now, ...extra });

/** Opens the session as the Controller does and returns a publisher that keeps the sequence going. */
async function publisherFor(journals, session, shape, options = {}) {
  const openTimed = await timed(() => journals.open(HOST, session, PUBLISHER, OPEN));
  const opened = openTimed.value;
  if (opened.refused) throw new Error(`The journal was not opened: ${opened.refused}`);
  let sequence = opened.watermark;
  const nextSequence = () => ++sequence;
  return {
    opened,
    openMs: openTimed.ms,
    /** Publishes `count` items starting at item number `first` in batches of `batch`; returns each publication's time. */
    async publishItems(first, count, batch) {
      const times = [];
      for (let at = first; at < first + count; at += batch) {
        const entries = entriesFor(shape, at, Math.min(batch, first + count - at), nextSequence, options);
        const result = await timed(() => journals.publish(HOST, session, opened.generation, entries));
        if (result.value.refusal) throw new Error(`The journal refused the benchmark data: ${result.value.refusal.reason}`);
        times.push(result.ms);
      }
      return times;
    },
    publish: entries => journals.publish(HOST, session, opened.generation, entries),
    nextSequence,
  };
}

/** Times the journal core's methods inside the service's own calls; returns the samples per method and a function that restores them. */
function instrument(names) {
  const samples = Object.fromEntries(names.map(name => [name, []]));
  const originals = names.map(name => [name, SessionJournal.prototype[name]]);
  for (const [name, original] of originals) {
    SessionJournal.prototype[name] = function (...args) {
      const start = performance.now();
      try { return original.apply(this, args); } finally { samples[name].push(performance.now() - start); }
    };
  }
  return { samples, restore: () => { for (const [name, original] of originals) SessionJournal.prototype[name] = original; } };
}

const results = {};
const report = {};
const record = (name, values, limit) => { results[name] = { ...summary(values), ...(limit === undefined ? {} : { limit }) }; };
const progress = message => console.error(`[${((performance.now() - started) / 1000).toFixed(0)}s] ${message}`);
const started = performance.now();

try {
  // 1. The plan's reference journal: 10,000 realistic items, then bulk and live-sized publications on top of it.
  progress('10,000 items');
  {
    const journals = service();
    const publisher = await publisherFor(journals, 'codex:ten-thousand', 'realistic', { liveOnly: true });
    const populate = await publisher.publishItems(0, 10_000, BATCH_ITEMS);
    record('populate10k.publish128', populate);
    record('publish128.on10k', await publisher.publishItems(10_000, 50 * BATCH_ITEMS, BATCH_ITEMS), 60);
    record('publish4.on10k', await publisher.publishItems(10_000 + 50 * BATCH_ITEMS, 100 * SMALL_BATCH_ITEMS, SMALL_BATCH_ITEMS));
    const cold = [];
    for (let round = 0; round < 7; round++) cold.push((await timed(() => service().status(HOST, 'codex:ten-thousand'))).ms);
    record('coldStatus.10k', cold, 800);
  }

  // 2. The worst resident case of the plan: 30,000 items of 2 KiB, every body resident.
  progress('30,000 items of 2 KiB');
  {
    const journals = service(WORST_CASE);
    const publisher = await publisherFor(journals, 'codex:thirty-thousand', 'twoKiB');
    await publisher.publishItems(0, 30_000, BATCH_ITEMS);
    const cold = [];
    for (let round = 0; round < 5; round++) {
      const loaded = await timed(() => service(WORST_CASE).status(HOST, 'codex:thirty-thousand'));
      if (!loaded.value) throw new Error('The 30,000-item journal was not found.');
      cold.push(loaded.ms);
    }
    record('coldStatus.30k.2KiB.resident', cold, 1500);
  }

  // 3. Realistic bodies, all resident, up to roughly the same size in bytes (the heaviest journal the cache holds).
  progress('8,000 realistic items, every body resident');
  {
    const journals = service(WORST_CASE);
    const publisher = await publisherFor(journals, 'codex:resident', 'realistic');
    await publisher.publishItems(0, 8_000, BATCH_ITEMS);
    const cold = [];
    for (let round = 0; round < 5; round++) cold.push((await timed(() => service(WORST_CASE).status(HOST, 'codex:resident'))).ms);
    record('coldStatus.8k.realistic.resident', cold);
  }

  // 4. A journal at the item limit, built through publications with the default limits and retention.
  progress('100,000 items');
  const big = 'codex:hundred-thousand';
  const bulkRounds = 30, smallRounds = 60;
  const tail = bulkRounds * BATCH_ITEMS + smallRounds * SMALL_BATCH_ITEMS;
  const baseItems = SESSION_ITEM_MAX - tail;
  let bigState;
  {
    const journals = service();
    const publisher = await publisherFor(journals, big, 'realistic', { liveOnly: true });
    const populate = await publisher.publishItems(0, baseItems, BATCH_ITEMS);
    record('populate100k.publish128', populate);
    const inside = instrument(['windowStart', 'evictRange', 'dropOldestLiveOnly']);
    record('publish128.on100k', await publisher.publishItems(baseItems, bulkRounds * BATCH_ITEMS, BATCH_ITEMS));
    for (const name of Object.keys(inside.samples)) record(`inPublish128.${name}.100k`, inside.samples[name].splice(0));
    record('publish4.on100k', await publisher.publishItems(baseItems + bulkRounds * BATCH_ITEMS, smallRounds * SMALL_BATCH_ITEMS, SMALL_BATCH_ITEMS));
    for (const name of Object.keys(inside.samples)) record(`inPublish4.${name}.100k`, inside.samples[name]);
    inside.restore();
    bigState = { size: (await stat(join(directory, 'journals.sqlite'))).size };
  }
  progress('100,000 items: cold loads');
  {
    const cold = [];
    for (let round = 0; round < 5; round++) {
      const loaded = await timed(() => service().status(HOST, big));
      if (!loaded.value) throw new Error('The 100,000-item journal was not found.');
      cold.push(loaded.ms);
    }
    record('coldStatus.100k', cold);
  }

  progress('100,000 items: internals of the journal core');
  {
    const loadTimes = [], measure = [], windowStart = [], indexBuild = [], carried = [], evictOnce = [], evictRange = [], dropLiveOnly = [];
    for (let round = 0; round < 5; round++) {
      loadTimes.push((await timed(() => store.load(`${HOST}:${big}`))).ms);
      const journal = new SessionJournal(await store.load(`${HOST}:${big}`));
      measure.push((await timed(async () => journal.residentBytes())).ms);
      indexBuild.push((await timed(async () => journal.index())).ms);
      for (let again = 0; again < 20; again++) windowStart.push((await timed(async () => journal.windowStart(RETAIN.turns, RETAIN.minItems))).ms);
      const reread = Array.from({ length: 400 }, (_, at) => { let n = baseItems + at * 7; if (isLiveOnly(n)) n += 1; return { row: realisticRow(n), digest: digestOf(n) }; });
      carried.push((await timed(async () => journal.carriedOnReplace(reread))).ms);
      if (round === 0) report.carriedOnReplace100k = journal.carriedOnReplace(reread);
      const start = journal.windowStart(RETAIN.turns, RETAIN.minItems);
      for (let again = 0; again < 20; again++) evictRange.push((await timed(async () => journal.evictRange(start, start))).ms);
      for (let again = 0; again < 20; again++) dropLiveOnly.push((await timed(async () => journal.dropOldestLiveOnly(2000))).ms);
      evictOnce.push((await timed(async () => journal.evict(RETAIN.turns, RETAIN.minItems))).ms);
    }
    record('core.storeLoad.100k', loadTimes);
    record('core.residentBytes.coldMeasure.100k', measure);
    record('core.index.build.100k', indexBuild);
    record('core.windowStart.per-publication.100k', windowStart);
    record('core.carriedOnReplace.100k', carried);
    record('core.evict.fullPass.100k', evictOnce);
    record('core.evictRange.emptyRange.per-publication.100k', evictRange);
    record('core.dropOldestLiveOnly.withinCap.per-publication.100k', dropLiveOnly);
  }

  progress('100,000 items: index pages, fills');
  let replaceState;
  {
    const journals = service();
    const publisher = await publisherFor(journals, big, 'realistic', { liveOnly: true });
    record('open.cold.100k', [publisher.openMs]);
    const pages = [];
    let after = publisher.opened.index.at(-1)?.seqStart;
    let listed = publisher.opened.index.length;
    while (publisher.opened.more && after !== undefined) {
      const page = await timed(() => journals.indexPage(HOST, big, publisher.opened.epoch, after, INDEX_PAGE_ITEMS));
      if (!page.value) throw new Error('An index page was refused.');
      pages.push(page.ms);
      listed += page.value.length;
      if (page.value.length < INDEX_PAGE_ITEMS) break;
      after = page.value.at(-1).seqStart;
    }
    report.indexListed = listed;
    record('indexPage.100k', pages);
    record('indexPage.100k.allPagesTotal', [pages.reduce((sum, ms) => sum + ms, 0)]);

    // Fills of 64 evicted items each (the protocol's bound), each with the page read in the same step; later fills pass the session cap.
    const fills = [];
    let n = 0, filled = 0, skipped = 0;
    for (let round = 0; round < 120; round++) {
      const items = [];
      while (items.length < 64 && n < baseItems - 1000) { if (!isLiveOnly(n)) items.push({ row: realisticRow(n), digest: digestOf(n) }); n++; }
      const read = { request: { requestId: `read-${round}`, agentId: 'agent', direction: 'tail', limit: 50 }, olderBeyondJournal: () => false };
      const result = await timed(() => journals.fill(HOST, big, items, read));
      filled += result.value.filled.length;
      skipped += result.value.skipped?.length ?? 0;
      fills.push(result.ms);
    }
    report.fill = { filled, skipped };
    record('fill64.on100k', fills);
    replaceState = { journals, publisher };
  }

  // 5. A replacement at 100,000 items. The realistic journal is replaced once; light rows give repeatable samples of the same item count.
  progress('replacement at 100,000 items');
  {
    const { publisher } = replaceState;
    const reread = Array.from({ length: 400 }, (_, at) => { let n = baseItems + at * 7; if (isLiveOnly(n)) n += 1; return { row: realisticRow(n), digest: digestOf(n) }; });
    const inside = instrument(['carriedOnReplace', 'replace', 'windowStart']);
    const replaced = await timed(() => publisher.publish([{ sequence: publisher.nextSequence(), op: 'replace', items: reread }]));
    inside.restore();
    if (replaced.value.refusal) throw new Error(`The replacement was refused: ${replaced.value.refusal.reason}`);
    record('replace400.on100k.realistic', [replaced.ms]);
    for (const name of Object.keys(inside.samples)) record(`inReplace.${name}.100k`, inside.samples[name]);
  }
  {
    const replaces = [];
    for (let round = 0; round < 5; round++) {
      const session = `codex:light-${round}`;
      const journals = service();
      const publisher = await publisherFor(journals, session, 'light', { liveOnly: true });
      await publisher.publishItems(0, SESSION_ITEM_MAX - 1000, 256);
      const reread = Array.from({ length: 400 }, (_, at) => { let n = at * 7; if (isLiveOnly(n)) n += 1; return { row: SHAPES.light(n), digest: digestOf(n) }; });
      const replaced = await timed(() => publisher.publish([{ sequence: publisher.nextSequence(), op: 'replace', items: reread }]));
      if (replaced.value.refusal) throw new Error(`The replacement was refused: ${replaced.value.refusal.reason}`);
      replaces.push(replaced.ms);
    }
    record('replace400.on99k.light', replaces);
  }
  report.databaseBytes = bigState.size;
  report.rssMb = Math.round(process.memoryUsage().rss / 2 ** 20);
} finally {
  database.close();
  await rm(directory, { recursive: true, force: true });
}

console.log(`node ${process.version} on ${cpus()[0]?.model ?? 'unknown cpu'}`);
let failed = false;
for (const [name, values] of Object.entries(results)) {
  const ok = values.limit === undefined || values.p95 <= values.limit;
  if (!ok) failed = true;
  const flag = values.limit === undefined ? 'info' : ok ? 'ok  ' : 'FAIL';
  console.log(`${flag} ${name}: n=${values.n} p50=${values.p50.toFixed(1)} p95=${values.p95.toFixed(1)} max=${values.max.toFixed(1)}${values.limit === undefined ? '' : ` (limit ${values.limit} at p95)`}`);
}
console.log(JSON.stringify(report));
process.exitCode = failed ? 1 : 0;
