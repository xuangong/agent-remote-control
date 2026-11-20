import { describe, expect, it } from 'vitest';
import type { AgentToolDetail } from '@orchardworks/agent-remote-protocol';
import { buildEveryKindConversation, TimelineRows } from '../testing/index.js';
import { translator } from './messages.js';
import { foldTurns, type Turn } from './turns.js';
import { fileName, liveStatus, workSummary } from './work-summary.js';

const en = translator('en'), zh = translator('zh');
const read = (path: string): AgentToolDetail => ({ type: 'read', filePath: path });
const edit = (path: string): AgentToolDetail => ({ type: 'edit', filePath: path });
const write = (path: string): AgentToolDetail => ({ type: 'write', filePath: path });
const shell = (command: string): AgentToolDetail => ({ type: 'shell', command });

/** The one turn a timeline of a prompt and these rows folds into. */
function turnOf(write: (rows: TimelineRows) => void, running = false): Turn {
  const rows = new TimelineRows();
  rows.user('Go', { key: 'u1', turnId: 't1' });
  write(rows);
  return foldTurns(rows.entries, running ? { turnId: 't1' } : null, running ? 'running' : 'idle')[0]!;
}
const summary = (write: (rows: TimelineRows) => void, t = en) => workSummary(turnOf(write).work, t);

describe('workSummary', () => {
  it.each([
    ['one read names the file', (r: TimelineRows) => r.tool('Read', read('/repo/docs/notes.md')), 'Read notes.md'],
    ['reads of several files count them', (r: TimelineRows) => { r.tool('Read', read('/a.md')); r.tool('Read', read('/b.md')); r.tool('Read', read('/a.md')); }, 'Read 2 files'],
    ['one edit names the file', (r: TimelineRows) => r.tool('Edit', edit('C:\\repo\\notes.md')), 'Edited notes.md'],
    ['edits of several files count them', (r: TimelineRows) => { r.tool('Edit', edit('/a.md')); r.tool('Write', write('/b.md')); }, 'Edited 2 files'],
    ['a new file is written', (r: TimelineRows) => r.tool('Write', write('/repo/notes.md')), 'Wrote notes.md'],
    ['one command', (r: TimelineRows) => r.tool('Bash', shell('ls')), 'Ran a command'],
    ['two commands', (r: TimelineRows) => { r.tool('Bash', shell('ls')); r.tool('Bash', shell('pwd')); }, 'Ran 2 commands'],
    ['a search', (r: TimelineRows) => r.tool('Grep', { type: 'search', query: 'x' }), 'Searched once'],
    ['web pages', (r: TimelineRows) => { r.tool('Fetch', { type: 'fetch', url: 'https://a.example' }); r.tool('Fetch', { type: 'fetch', url: 'https://b.example' }); }, 'Opened 2 web pages'],
    ['another tool', (r: TimelineRows) => r.tool('Task', { type: 'other', description: 'Delegate' }), 'Used a tool'],
    ['reasoning', (r: TimelineRows) => r.reasoning(), 'Thought it through'],
    ['a todo', (r: TimelineRows) => r.todo([{ text: 'One', completed: false }]), 'Updated the plan'],
    ['a compaction', (r: TimelineRows) => r.compaction('completed'), 'Tidied up the context'],
    ['a background check', (r: TimelineRows) => { r.user('Check', { background: { id: 'c1', kind: 'review', status: 'silent' } }); }, 'Ran a background check'],
    ['clauses in the order the turn did them', (r: TimelineRows) => { r.tool('Bash', shell('ls')); r.tool('Read', read('/a.md')); r.tool('Read', read('/b.md')); r.tool('Read', read('/c.md')); r.tool('Write', write('/notes.md')); },
      'Ran a command, read 3 files, wrote notes.md'],
    ['more than three kinds', (r: TimelineRows) => { r.tool('Read', read('/a.md')); r.tool('Edit', edit('/a.md')); r.tool('Bash', shell('ls')); r.tool('Grep', { type: 'search', query: 'x' }); r.reasoning(); },
      'Read a.md, edited a.md, ran a command, and 2 more'],
    ['remarks and notices alone count steps', (r: TimelineRows) => { r.assistant('Trying.'); r.error('Broken'); }, '2 steps'],
  ] as const)('%s', (_name, write, text) => {
    expect(summary(write).text).toBe(text);
  });

  it('says the same work in Chinese', () => {
    expect(summary(r => { r.tool('Read', read('/a.md')); r.tool('Read', read('/b.md')); r.tool('Read', read('/c.md')); r.tool('Write', write('/w/notes.md')); }, zh).text).toBe('翻了 3 个文件，写好了 notes.md');
    expect(summary(r => { r.tool('Read', read('/a.md')); r.tool('Edit', edit('/a.md')); r.tool('Bash', shell('ls')); r.tool('Grep', { type: 'search', query: 'x' }); r.reasoning(); }, zh).text)
      .toBe('翻了 a.md，改了 a.md，跑了 1 条命令，还有 2 件事');
  });

  it('counts failed steps, a notice group as one', () => {
    expect(summary(r => { r.tool('Bash', shell('lint'), 'failed'); r.error('First'); r.error('Second'); r.tool('Bash', shell('ls'), 'canceled'); })).toEqual({ text: 'Ran 2 commands', failed: 2, running: false });
  });

  it('says when a step still runs', () => {
    expect(summary(r => { r.tool('Bash', shell('npm test'), 'running'); }).running).toBe(true);
  });

  it('is no line for a turn without work, and answered interactions add no clause', () => {
    expect(summary(() => {})).toEqual({ text: '', failed: 0, running: false });
    expect(summary(r => { r.interaction({ kind: 'external_action', requestId: 'x', title: 'Go', message: '', url: 'https://example.com' }, { kind: 'external_action', action: 'completed' }); }).text).toBe('');
  });

  it('summarises the every-kind turn in at most three clauses', () => {
    const { entries } = buildEveryKindConversation();
    const first = foldTurns(entries, null, 'idle')[0]!;
    expect(workSummary(first.work, en)).toEqual({ text: 'Thought it through, ran 3 commands, read 2 files, and 7 more', failed: 2, running: false });
  });

  it('names a file by the last segment of its path', () => {
    expect(['/a/b/notes.md', 'C:\\a\\notes.md', 'notes.md', '/a/dir/'].map(fileName)).toEqual(['notes.md', 'notes.md', 'notes.md', 'dir']);
  });
});

describe('liveStatus', () => {
  const live = (write: (rows: TimelineRows) => void, t = en) => liveStatus('Chief', turnOf(write, true), t);
  it.each([
    ['a test command', (r: TimelineRows) => r.tool('Bash', shell('pnpm test --run'), 'running'), 'Chief is running tests'],
    ['another command', (r: TimelineRows) => r.tool('Bash', shell('ls -la'), 'running'), 'Chief is running a command'],
    ['an edit', (r: TimelineRows) => r.tool('Edit', edit('/repo/notes.md'), 'running'), 'Chief is editing notes.md'],
    ['a new file', (r: TimelineRows) => r.tool('Write', write('/repo/notes.md'), 'running'), 'Chief is writing notes.md'],
    ['a read', (r: TimelineRows) => r.tool('Read', read('/repo/notes.md'), 'running'), 'Chief is reading notes.md'],
    ['a search', (r: TimelineRows) => r.tool('Grep', { type: 'search', query: 'x' }, 'running'), 'Chief is searching'],
    ['a web page', (r: TimelineRows) => r.tool('Fetch', { type: 'fetch', url: 'https://a.example' }, 'running'), 'Chief is reading a web page'],
    ['another tool', (r: TimelineRows) => r.tool('mcp__docs__lookup', { type: 'other', description: 'Look up' }, 'running'), 'Chief is using lookup'],
    ['a compaction', (r: TimelineRows) => r.compaction('loading'), 'Chief is tidying up the context'],
    ['reasoning last', (r: TimelineRows) => { r.tool('Bash', shell('ls')); r.reasoning(); }, 'Chief is thinking'],
    ['a reply after the steps', (r: TimelineRows) => { r.tool('Bash', shell('ls')); r.assistant('Here is'); }, 'Chief is writing a reply'],
    ['nothing yet', () => {}, 'Chief is working'],
  ] as const)('%s', (_name, write, sentence) => {
    expect(live(write).sentence).toBe(sentence);
  });

  it('adds the progress of the latest todo', () => {
    expect(live(r => { r.todo([{ text: 'A', completed: true }, { text: 'B', completed: false }]); r.todo([{ text: 'A', completed: true, status: 'completed' }, { text: 'B', completed: false, status: 'in_progress' },
      { text: 'C', completed: false, status: 'pending' }, { text: 'D', completed: true }, { text: 'E', completed: false }]); r.tool('Bash', shell('npm test'), 'running'); }))
      .toEqual({ sentence: 'Chief is running tests', progress: '2 of 5 done' });
    expect(live(r => { r.tool('Bash', shell('ls'), 'running'); }).progress).toBeUndefined();
  });

  it('speaks Chinese in the design voice', () => {
    expect(live(r => r.tool('Bash', shell('npm test'), 'running'), zh).sentence).toBe('Chief 在跑测试，稍等～');
    expect(live(r => { r.todo([{ text: 'A', completed: true }, { text: 'B', completed: false }]); r.tool('Edit', edit('/notes.md'), 'running'); }, zh)).toEqual({ sentence: 'Chief 在改 notes.md', progress: '完成 1/2' });
  });
});
