import { describe, expect, it } from 'vitest';
import type { AgentFileChange, AgentToolResult } from '@orchardworks/agent-remote-protocol';
import { buildEveryKindConversation, TimelineRows } from '../testing/index.js';
import { sessionFiles } from './session-files.js';

const changes = (...files: AgentFileChange[]): AgentToolResult => ({ content: [{ type: 'json', value: { format: 'file_changes', version: 1, files } }] });
const edit = (rows: TimelineRows, key: string, ...files: AgentFileChange[]) =>
  rows.tool('Edit', { type: 'edit', filePath: files[0]?.path ?? '/x' }, 'completed', { key, result: changes(...files) });
const sha = 'a'.repeat(64);

describe('sessionFiles', () => {
  it('lists nothing for an empty conversation and for one without files', () => {
    expect(sessionFiles([])).toEqual([]);
    const rows = new TimelineRows();
    rows.user('Hi'); rows.assistant('Hello'); rows.tool('Bash', { type: 'shell', command: 'ls' });
    expect(sessionFiles(rows.entries)).toEqual([]);
  });

  it('lists one row per path and the newest change wins', () => {
    const rows = new TimelineRows();
    edit(rows, 'first', { path: '/a.md', kind: 'added', diff: '@@ -0,0 +1,2 @@\n+one\n+two' });
    edit(rows, 'second', { path: '/a.md', kind: 'modified', diff: '@@ -1,2 +1,2 @@\n one\n-two\n+three' });
    expect(sessionFiles(rows.entries)).toEqual([{ path: '/a.md', change: 'modified', source: 'change', entryKey: 'second', additions: 1, deletions: 1 }]);
  });

  it('counts only changed lines, not the file headers', () => {
    const rows = new TimelineRows();
    edit(rows, 'e', { path: '/a.md', kind: 'modified', diff: '--- a/a.md\n+++ b/a.md\n@@ -1 +1 @@\n--old\n+++new' });
    expect(sessionFiles(rows.entries)[0]).toMatchObject({ additions: 1, deletions: 1 });
  });

  it('keeps deleted files with their kind, even after an earlier add', () => {
    const rows = new TimelineRows();
    edit(rows, 'add', { path: '/gone.md', kind: 'added', diff: '@@ -0,0 +1 @@\n+x' });
    edit(rows, 'remove', { path: '/gone.md', kind: 'deleted', diff: '@@ -1 +0,0 @@\n-x' });
    expect(sessionFiles(rows.entries)).toEqual([{ path: '/gone.md', change: 'deleted', source: 'change', entryKey: 'remove', additions: 0, deletions: 1 }]);
  });

  it('keys a rename by its new path', () => {
    const rows = new TimelineRows();
    edit(rows, 'rename', { path: '/new.md', previousPath: '/old.md', kind: 'renamed', diff: '' });
    expect(sessionFiles(rows.entries).map(file => [file.path, file.change])).toEqual([['/new.md', 'renamed']]);
  });

  it('lists the resources and images a person attached', () => {
    const rows = new TimelineRows();
    rows.user('See these', { key: 'prompt', content: [
      { type: 'text', text: 'See these' },
      { type: 'resource', locator: 'input-resource:brief', label: 'Brief', name: 'brief.pdf', mediaType: 'application/pdf', byteLength: 10, sha256: sha },
      { type: 'image', locator: 'input-image:sketch', label: 'Sketch' },
    ] });
    expect(sessionFiles(rows.entries)).toEqual([
      { path: 'Sketch', source: 'image', entryKey: 'prompt' },
      { path: 'brief.pdf', source: 'resource', entryKey: 'prompt' },
    ]);
  });

  it('lists a file a tool call names when it reports no changes, and skips failed calls', () => {
    const rows = new TimelineRows();
    rows.tool('Edit', { type: 'edit', filePath: '/edited.md' }, 'completed', { key: 'edited' });
    rows.tool('Write', { type: 'write', filePath: '/written.md' }, 'completed', { key: 'written' });
    rows.tool('Write', { type: 'write', filePath: '/failed.md' }, 'failed');
    rows.tool('Read', { type: 'read', filePath: '/read.md' });
    expect(sessionFiles(rows.entries)).toEqual([
      { path: '/written.md', source: 'change', entryKey: 'written' },
      { path: '/edited.md', change: 'modified', source: 'change', entryKey: 'edited' },
    ]);
  });

  it('orders files newest first, a path touched again moving to the front', () => {
    const rows = new TimelineRows();
    edit(rows, 'a1', { path: '/a.md', kind: 'added', diff: '' });
    edit(rows, 'b1', { path: '/b.md', kind: 'added', diff: '' }, { path: '/c.md', kind: 'added', diff: '' });
    edit(rows, 'a2', { path: '/a.md', kind: 'modified', diff: '' });
    expect(sessionFiles(rows.entries).map(file => file.path)).toEqual(['/a.md', '/c.md', '/b.md']);
  });

  it('reads the files of a whole conversation', () => {
    const files = sessionFiles(buildEveryKindConversation().entries);
    expect(files.map(file => file.path)).toEqual(expect.arrayContaining(['/Users/me/notes/notes.md', '/Users/me/notes/README.md', 'brief.pdf', 'Sketch']));
    expect(new Set(files.map(file => file.path)).size).toBe(files.length);
    expect(files.find(file => file.path === '/Users/me/notes/README.md')?.change).toBe('renamed');
  });
});
