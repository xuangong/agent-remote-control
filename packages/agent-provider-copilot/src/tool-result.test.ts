import {expect, it} from 'vitest';
import type {SessionEvent} from '@github/copilot-sdk';
import {TOOL_RESULT_MAX_CHARS} from '@orchardworks/agent-provider-sdk';
import {Projector} from './projector.js';

const patch = '*** Begin Patch\n*** Add File: /workspace/plan.md\n+# Plan\n*** End Patch';
const diff = 'diff --git a/workspace/plan.md b/workspace/plan.md\ncreate file mode 100644\n--- a/dev/null\n+++ b/workspace/plan.md\n@@ -1,0 +1,1 @@\n+# Plan\n';
function event(type: string, data: unknown): SessionEvent {
  return {type, data, id: crypto.randomUUID(), parentId: null, timestamp: new Date().toISOString()} as SessionEvent;
}
function project(argumentsValue: unknown, result: unknown, success = true, delivery: 'live' | 'history' = 'live') {
  const p = new Projector();
  const start = p.project(event('tool.execution_start', {toolCallId: 'patch', toolName: 'apply_patch', arguments: argumentsValue}), delivery)!.event;
  const end = p.project(event('tool.execution_complete', {toolCallId: 'patch', success, result, ...(!success ? {error: {message: 'Plan boundary denied'}} : {})}), delivery)!.event;
  if (end.type !== 'timeline' || end.item.type !== 'tool_call') throw new Error('Missing tool result');
  return {start, item: end.item};
}

it.each(['live', 'history'] as const)('projects a native patch into file changes in %s', delivery => {
  const {start, item} = project(patch, {content: 'Added 1 file(s)', detailedContent: diff}, true, delivery);
  expect(start).toMatchObject({item: {detail: {type: 'write', filePath: '/workspace/plan.md'}}});
  expect(item).toMatchObject({status: 'completed', result: {content: [
    {type: 'text', text: 'Added 1 file(s)'},
    {type: 'json', value: {format: 'file_changes', version: 1, files: [{path: '/workspace/plan.md', kind: 'added', diff}]}},
  ]}});
}, 10000);

it('preserves multiple files, deletion and rename from actual result diffs', () => {
  const update = 'diff --git a/old name.txt b/new name.txt\nrename from old name.txt\nrename to new name.txt\n--- a/old name.txt\n+++ b/new name.txt\n@@ -1 +1 @@\n-old\n+new\n';
  const deletion = 'diff --git a/removed.txt b/removed.txt\ndeleted file mode 100644\n--- a/removed.txt\n+++ b/dev/null\n@@ -1 +0,0 @@\n-gone\n';
  const input = '*** Begin Patch\n*** Update File: old name.txt\n*** Move to: new name.txt\n@@\n-old\n+new\n*** Delete File: removed.txt\n*** End Patch';
  const {item} = project(input, {content: 'Updated files', detailedContent: update + deletion, structuredContent: {native: true}});
  expect(item.result?.content).toEqual([
    {type: 'text', text: 'Updated files'},
    {type: 'json', value: {format: 'file_changes', version: 1, files: [
      {path: 'new name.txt', previousPath: 'old name.txt', kind: 'renamed', diff: update},
      {path: 'removed.txt', kind: 'deleted', diff: deletion},
    ]}},
    {type: 'json', value: {native: true}},
  ]);
}, 10000);

it('does not turn a proposed or denied patch into successful file changes', () => {
  const {item} = project(patch, undefined, false);
  expect(item).toMatchObject({status: 'failed', error: 'Plan boundary denied', result: {content: []}});
  expect(project(patch, {content: 'No diff returned'}).item.result?.content).toEqual([{type: 'text', text: 'No diff returned'}]);
}, 10000);

it('retains unrecognized detailed content without inventing file metadata or duplicating equal text', () => {
  const native = 'Diff unavailable: binary file changed';
  expect(project({}, {content: 'Done', detailedContent: native}).item.result?.content).toEqual([{type: 'text', text: 'Done'}, {type: 'text', text: native}]);
  expect(project({}, {content: native, detailedContent: native}).item.result?.content).toEqual([{type: 'text', text: native}]);
}, 10000);

it('bounds large detailed results without losing the truncation marker', () => {
  const {item} = project(patch, {content: 'Added', detailedContent: diff + '+large\n'.repeat(20000)});
  expect(item.result?.truncated).toBe(true);
  expect(item.result!.content.reduce((n, block) => n + (block.type === 'text' ? block.text : JSON.stringify(block.value)).length, 0)).toBeLessThanOrEqual(TOOL_RESULT_MAX_CHARS);
}, 10000);

it.each([undefined, diff])('renders a diff supplied as content when detailedContent is %s', detailedContent => {
  expect(project(patch, {content: diff, detailedContent}).item.result?.content).toEqual([
    {type: 'json', value: {format: 'file_changes', version: 1, files: [{path: '/workspace/plan.md', kind: 'added', diff}]}},
  ]);
}, 10000);

it('keeps an incomplete multi-file diff as raw text instead of dropping the unrecognized file', () => {
  const malformed = diff + 'diff --git a/unknown b/unknown\n--- a/unknown\n';
  expect(project(patch, {content: 'Done', detailedContent: malformed}).item.result?.content).toEqual([
    {type: 'text', text: 'Done'}, {type: 'text', text: malformed},
  ]);
}, 10000);

it('uses header paths rather than header-like deleted lines inside a hunk', () => {
  const output = 'diff --git "a/name with spaces.txt" "b/name with spaces.txt"\n--- "a/name with spaces.txt"\n+++ "b/name with spaces.txt"\n@@ -1 +1 @@\n--- a/not-a-file\n+++ b/not-a-file\n';
  expect(project('', {content: 'Changed', detailedContent: output}).item.result?.content[1]).toEqual({type: 'json', value: {
    format: 'file_changes', version: 1, files: [{path: 'name with spaces.txt', kind: 'modified', diff: output}],
  }});
}, 10000);
