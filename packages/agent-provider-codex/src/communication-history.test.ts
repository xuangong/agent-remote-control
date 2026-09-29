import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexCommunicationHistory } from './communication-history.js';
import { projectCodexThreadHistory } from './history.js';

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const row = (type: string, payload: unknown, time = 1000) => JSON.stringify({ type, payload, timestamp: new Date(time).toISOString() }) + '\n';
const meta = (id: string, agentPath: string, parent?: string) => row('session_meta', { id, agent_path: agentPath, parent_thread_id: parent });
const message = (id: string, author: string, recipient: string, turnId: string, text: string, time = 1100) => row('response_item', {
  type: 'agent_message', id, author, recipient, content: [{ type: 'input_text', text }],
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
}, time);
const completed = (threadId: string, turnId: string, id: string, time: number) => row('event_msg', {
  type: 'item_completed', thread_id: threadId, turn_id: turnId, item: { type: 'CommandExecution', id },
}, time);

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'arc-communication-')); dirs.push(dir);
  const childPath = path.join(dir, 'child.jsonl'), parentPath = path.join(dir, 'parent.jsonl');
  const childText = meta('child', '/root/review', 'parent')
    + message('task', '/root', '/root/review', 'ct', 'Full **initial task**\nSecond line.')
    + completed('child', 'ct', 'cmd', 1200)
    + message('followup', '/root', '/root/review', 'ct', 'Follow up.', 1300);
  const parentText = meta('parent', '/root')
    + message('reply', '/root/review', '/root', 'pt', 'Complete reply.', 1250)
    + message('unrelated', '/root/other', '/root', 'pt', 'PRIVATE OTHER TASK', 1270);
  await writeFile(childPath, childText); await writeFile(parentPath, parentText);
  const child = { id: 'child', path: childPath, parentThreadId: 'parent', agentPath: '/root/review',
    turns: [{ id: 'ct', startedAt: 1, items: [{ type: 'commandExecution', id: 'cmd', command: 'pwd', status: 'completed' }] }] };
  const parent = { id: 'parent', path: parentPath, agentPath: '/root', turns: [{ id: 'pt', startedAt: 1,
    items: [{ type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/review' }] }] };
  const read = vi.fn(async (id: string) => ({ thread: id === 'parent' ? parent : child }));
  const reader = new CodexCommunicationHistory(read);
  return { child, parent, childPath, parentPath, childText, reader, read };
}
const communications = (items: Awaited<ReturnType<CodexCommunicationHistory['supplement']>>) =>
  items.filter(o => o.event.type === 'timeline' && o.event.item.type === 'agent_communication');

it('recovers both directions in the child without borrowing parent turn identity or sibling messages', async () => {
  const f = await fixture(); const snapshot = { thread: f.child };
  const original = projectCodexThreadHistory(snapshot, 'child');
  const result = await f.reader.supplement(snapshot, original);
  expect(result.map(o => o.sourceKey)).toEqual(['item:task:completed', 'item:cmd:completed', 'item:reply:completed', 'item:followup:completed']);
  expect(communications(result)).toHaveLength(3);
  expect(result[0]).toMatchObject({ event: { turnId: 'ct', item: { text: 'Full **initial task**\nSecond line.' } } });
  expect(result[2]?.event).not.toHaveProperty('turnId');
  expect(JSON.stringify(result)).not.toContain('PRIVATE OTHER TASK');
  expect(result[1]).toEqual(original[0]);
  expect(await f.reader.supplement(snapshot, result)).toEqual(result);
});

it('recovers outgoing tasks in the parent and preserves all its received replies', async () => {
  const f = await fixture(); const snapshot = { thread: f.parent };
  const result = await f.reader.supplement(snapshot, projectCodexThreadHistory(snapshot, 'parent'));
  expect(communications(result).map(o => o.sourceKey)).toEqual(['item:task:completed', 'item:reply:completed', 'item:unrelated:completed', 'item:followup:completed']);
  expect(communications(result)[0]?.event).not.toHaveProperty('turnId');
  expect(communications(result)[1]?.event).toMatchObject({ turnId: 'pt' });
  expect(await f.reader.supplement(snapshot, result)).toEqual(result);
});

it('partitions cross-session receipts across history pages without reusing the peer turn', async () => {
  const f = await fixture();
  await appendFile(f.childPath, row('event_msg', { type: 'task_started', turn_id: 'ct2' }, 2000)
    + message('task2', '/root', '/root/review', 'ct2', 'Second task', 2100));
  await appendFile(f.parentPath, message('reply2', '/root/review', '/root', 'pt', 'Second reply', 2200));
  const older = await f.reader.supplement({ thread: f.child }, []);
  const newer = await f.reader.supplement({ thread: { ...f.child, turns: [{ id: 'ct2', startedAt: 2, items: [] }] } }, []);
  expect(communications(older).map(o => o.sourceKey)).toEqual(['item:task:completed', 'item:reply:completed', 'item:followup:completed']);
  expect(communications(newer).map(o => o.sourceKey)).toEqual(['item:task2:completed', 'item:reply2:completed']);
  expect(communications(newer)[1]?.event).not.toHaveProperty('turnId');
});

it('derives missing root path from its received records without assuming a root name', async () => {
  const f = await fixture();
  await writeFile(f.parentPath, row('session_meta', { id: 'parent' })
    + message('reply', '/root/review', '/root', 'pt', 'Complete reply.', 1250));
  delete (f.parent as { agentPath?: string }).agentPath;
  const snapshot = { thread: f.child };
  expect(communications(await f.reader.supplement(snapshot, projectCodexThreadHistory(snapshot, 'child')))
    .map(o => o.sourceKey)).toContain('item:reply:completed');
});

it('keeps pagination scoped to native turns and gives native communications precedence', async () => {
  const f = await fixture();
  await appendFile(f.childPath, message('later', '/root', '/root/review', 'later-turn', 'Later task', 2100));
  const native = { type: 'agentCommunication', id: 'task', sender: '/root', recipient: '/root/review', text: 'Native authoritative task' };
  const snapshot = { thread: { ...f.child, turns: [{ ...f.child.turns[0], items: [native, ...f.child.turns[0]!.items] }] } };
  const result = await f.reader.supplement(snapshot, projectCodexThreadHistory(snapshot, 'child'));
  expect(result.filter(o => o.sourceKey === 'item:task:completed')).toHaveLength(1);
  expect(result[0]).toMatchObject({ event: { item: { text: 'Native authoritative task' } } });
  expect(result.some(o => o.sourceKey === 'item:later:completed')).toBe(false);
});

it('retains native file metadata for subsequent history pages containing only a thread identity', async () => {
  const f = await fixture();
  f.reader.rememberThread(f.child);
  const result = await f.reader.supplement({ thread: { id: 'child', turns: f.child.turns } }, []);
  expect(communications(result).map(o => o.sourceKey)).toEqual(['item:task:completed', 'item:reply:completed', 'item:followup:completed']);
});

it('reads appended complete lines once and recovers after file replacement', async () => {
  const f = await fixture(); const snapshot = { thread: f.child };
  await f.reader.supplement(snapshot, []);
  const appended = message('new', '/root', '/root/review', 'ct', '新消息😀', 1400);
  await appendFile(f.childPath, appended.slice(0, -4));
  expect(communications(await f.reader.supplement(snapshot, [])).some(o => o.sourceKey === 'item:new:completed')).toBe(false);
  await appendFile(f.childPath, appended.slice(-4));
  expect(communications(await f.reader.supplement(snapshot, [])).filter(o => o.sourceKey === 'item:new:completed')).toHaveLength(1);
  await writeFile(f.childPath, meta('child', '/root/review', 'parent') + message('replacement', '/root', '/root/review', 'ct', 'Replaced', 1500));
  const result = communications(await f.reader.supplement(snapshot, []));
  expect(result.some(o => o.sourceKey === 'item:task:completed')).toBe(false);
  expect(result.some(o => o.sourceKey === 'item:replacement:completed')).toBe(true);
});

it('preserves received record order even when timestamps move backwards', async () => {
  const f = await fixture();
  await writeFile(f.childPath, meta('child', '/root/review')
    + message('z-first', '/root', '/root/review', 'ct', 'First receipt', 1300)
    + message('a-second', '/root', '/root/review', 'ct', 'Second receipt', 1200));
  delete (f.child as { parentThreadId?: string }).parentThreadId;
  const result = await f.reader.supplement({ thread: f.child }, []);
  expect(communications(result).map(o => o.sourceKey)).toEqual(['item:z-first:completed', 'item:a-second:completed']);
});

it('does not expose ciphertext, incomplete mixed plaintext or messages without native turn attribution', async () => {
  const f = await fixture();
  await appendFile(f.childPath, row('response_item', { type: 'agent_message', id: 'encrypted', author: '/root', recipient: '/root/review',
    content: [{ type: 'input_text', text: 'PARTIAL_ENVELOPE' }, { type: 'encrypted_content', encrypted_content: 'PRIVATE_CIPHER' }],
    internal_chat_message_metadata_passthrough: { turn_id: 'ct' } }, 1400));
  await appendFile(f.childPath, row('response_item', { type: 'agent_message', id: 'no-turn', author: '/root', recipient: '/root/review', content: [{ type: 'input_text', text: 'UNKNOWN_TURN' }] }));
  const result = await f.reader.supplement({ thread: f.child }, []);
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CIPHER|PARTIAL_ENVELOPE|UNKNOWN_TURN/);
  expect(communications(result).find(o => o.sourceKey === 'item:encrypted:completed')).toMatchObject({ event: { item: { text: expect.stringContaining('unavailable') } } });
});

it('fails closed on a mismatched file identity and retains usable native history when files are missing', async () => {
  const f = await fixture(); const snapshot = { thread: f.child }; const original = projectCodexThreadHistory(snapshot, 'child');
  await writeFile(f.childPath, meta('different', '/root/review') + message('secret', '/root', '/root/review', 'ct', 'SECRET'));
  let result = await f.reader.supplement(snapshot, original);
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(result).toContainEqual(original[0]);
  expect(result.some(o => o.event.type === 'timeline' && o.event.item.type === 'error')).toBe(true);
  await rm(f.childPath);
  result = await f.reader.supplement(snapshot, original);
  expect(result).toContainEqual(original[0]);
});
