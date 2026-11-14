import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { ProjectedTimelineEntry, TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { createSessionReplies, replyPreview, type ReplySource } from './session-replies.js';

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function file() {
  const directory = await mkdtemp(join(tmpdir(), 'session-replies-')); directories.push(directory);
  return join(directory, 'nested', 'session-replies.json');
}

const ref = { providerId: 'codex', nativeSessionId: 'thread' };
let seq = 0;
function entry(item: ProjectedTimelineEntry['item'], timestamp: string): ProjectedTimelineEntry {
  seq++;
  return { providerId: 'codex', item, timestamp, seqStart: seq, seqEnd: seq, sourceSeqRanges: [], collapsed: [], resources: [] } as ProjectedTimelineEntry;
}
const reply = (text: string, timestamp: string) => entry({ type: 'assistant_message', text } as ProjectedTimelineEntry['item'], timestamp);
const request = (text: string, timestamp: string) => entry({ type: 'user_message', text } as ProjectedTimelineEntry['item'], timestamp);
function source(entries: ProjectedTimelineEntry[], cursor: TimelineCursor = { epoch: 'e', seq: 1 }, hasOlder = false) {
  const state = { entries, cursor, reads: 0, hasOlder };
  const value: ReplySource & { state: typeof state } = {
    state,
    timelineCursor: () => state.cursor,
    fetchTimeline: request => {
      state.reads++;
      expect(request).toMatchObject({ direction: 'tail' });
      return { payload: { entries: state.entries.slice(-request.limit), hasOlder: state.hasOlder || state.entries.length > request.limit } };
    },
  };
  return value;
}

it('turns a reply into a short plain-text preview', () => {
  expect(replyPreview('**Done.** The `release` notes are in [the doc](https://example.com/doc).\n\n# Next\n- ship it')).toBe('Done. The release notes are in the doc. Next ship it');
  expect(replyPreview('```ts\nconst a = 1;\n```\nCompiled.')).toBe('Compiled.');
  expect(replyPreview('   \n ')).toBeUndefined();
  const long = replyPreview('word '.repeat(80))!;
  expect(long.length).toBeLessThanOrEqual(160);
  expect(long.endsWith('…')).toBe(true);
});

it("remembers a session's latest reply, reading its tail only when its timeline moved", () => {
  const replies = createSessionReplies();
  const agent = source([request('Ship it?', '2026-11-14T10:00:00.000Z'), reply('Shipped to production.', '2026-11-14T10:01:00.000Z'), request('Thanks', '2026-11-14T10:02:00.000Z')]);
  replies.observe(ref, 'agent', agent);
  expect(replies.facts(ref)).toEqual({ replyAt: Date.parse('2026-11-14T10:01:00.000Z'), preview: 'Shipped to production.' });
  replies.observe(ref, 'agent', agent);
  expect(agent.state.reads).toBe(1);
  // A tail without a reply (a long tool run) keeps what is known.
  agent.state.entries = [request('Run the suite', '2026-11-14T10:03:00.000Z')];
  agent.state.cursor = { epoch: 'e', seq: 2 };
  replies.observe(ref, 'agent', agent);
  expect(replies.facts(ref)?.preview).toBe('Shipped to production.');
  agent.state.entries = [reply('All 42 tests pass.', '2026-11-14T10:05:00.000Z')];
  agent.state.cursor = { epoch: 'e', seq: 3 };
  replies.observe(ref, 'agent', agent);
  expect(replies.facts(ref)).toEqual({ replyAt: Date.parse('2026-11-14T10:05:00.000Z'), preview: 'All 42 tests pass.' });
  replies.close();
});

it('keeps the most recent replies within its limit', () => {
  const replies = createSessionReplies({ limit: 2 });
  for (const [index, minute] of [[1, '01'], [2, '02'], [3, '03']] as const) {
    replies.observe({ providerId: 'codex', nativeSessionId: `thread-${index}` }, `agent-${index}`, source([reply(`Reply ${index}`, `2026-11-14T10:${minute}:00.000Z`)]));
  }
  expect(replies.facts({ providerId: 'codex', nativeSessionId: 'thread-1' })).toBeUndefined();
  expect(replies.facts({ providerId: 'codex', nativeSessionId: 'thread-3' })?.preview).toBe('Reply 3');
  replies.close();
});

it('keeps replies on disk across restarts and ignores a damaged file', async () => {
  const path = await file();
  const first = createSessionReplies({ file: path, saveDelayMs: 0 });
  first.observe(ref, 'agent', source([reply('Shipped.', '2026-11-14T10:01:00.000Z')]));
  await first.flush();
  first.close();
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  const second = createSessionReplies({ file: path });
  expect(second.facts(ref)).toEqual({ replyAt: Date.parse('2026-11-14T10:01:00.000Z'), preview: 'Shipped.' });
  second.close();
  await writeFile(path, '{ not json');
  const third = createSessionReplies({ file: path });
  expect(third.facts(ref)).toBeUndefined();
  third.close();
});

it('reads a session again once older history arrives, which leaves its timeline position where it was', () => {
  const replies = createSessionReplies();
  // Just attached: the Host has not loaded the session's history yet.
  const agent = source([], { epoch: 'e', seq: 0 }, true);
  replies.observe(ref, 'agent', agent);
  expect(replies.facts(ref)).toBeUndefined();
  // A page loads earlier history: it is prepended, so the position does not move.
  agent.state.entries = [request('Ship it?', '2026-11-14T10:00:00.000Z'), reply('Shipped.', '2026-11-14T10:01:00.000Z')];
  agent.state.hasOlder = false;
  replies.observe(ref, 'agent', agent);
  expect(replies.facts(ref)?.preview).toBe('Shipped.');
  // With everything read and nothing new, the tail is not read again.
  const reads = agent.state.reads;
  replies.observe(ref, 'agent', agent);
  expect(agent.state.reads).toBe(reads);
  replies.close();
});

it('looks further back when the latest entries are all work, not replies', () => {
  const replies = createSessionReplies();
  const work = Array.from({ length: 20 }, (_, index) => request(`Step ${index}`, '2026-11-14T10:02:00.000Z'));
  replies.observe(ref, 'agent', source([reply('Plan ready.', '2026-11-14T10:01:00.000Z'), ...work]));
  expect(replies.facts(ref)?.preview).toBe('Plan ready.');
  replies.close();
});
