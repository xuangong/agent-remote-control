import {boundToolResult, type AgentFileChange, type AgentToolDetail, type AgentToolResult, type AgentToolResultContent, type AgentToolResultJson} from '@orchardworks/agent-provider-sdk';

/** Patch input describes intent only; completed file changes must come from native output. */
export function patchFiles(input: unknown): {path: string; operation: string}[] {
  if (typeof input !== 'string' || !input.startsWith('*** Begin Patch\n')) return [];
  return [...input.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm)]
    .map(match => ({path: match[2]!, operation: match[1]!}));
}

export function copilotToolResult(name: string, detail: AgentToolDetail, result: unknown, paths: readonly string[] = []): AgentToolResult {
  if (!result || typeof result !== 'object') return {content: []};
  const native = result as {content?: string; detailedContent?: string; structuredContent?: AgentToolResultJson};
  const content: AgentToolResultContent[] = [];
  const summary = typeof native.content === 'string' ? native.content : '';
  const output = typeof native.detailedContent === 'string' && native.detailedContent ? native.detailedContent : summary;
  const files = name === 'apply_patch' || detail.type === 'edit' || detail.type === 'write'
    ? fileChanges(output, paths) : undefined;
  if (summary && (summary !== output || !files)) content.push({type: 'text', text: summary});
  if (files || output && output !== summary) {
    content.push(files ? {type: 'json', value: {format: 'file_changes', version: 1, files: files.map(file => ({...file}))}}
      : {type: 'text', text: output});
  }
  if (native.structuredContent !== undefined) content.push({type: 'json', value: native.structuredContent});
  return boundToolResult({content});
}

function fileChanges(text: string, paths: readonly string[]): AgentFileChange[] | undefined {
  const start = text.indexOf('diff --git ');
  if (start < 0 || text.slice(0, start).trim()) return undefined;
  const sections = text.slice(start).split(/(?=^diff --git )/m);
  const files: AgentFileChange[] = [];
  for (const diff of sections) {
    const header = diff.split(/^@@/m, 1)[0]!;
    const before = diffPath(header.match(/^--- (.+)$/m)?.[1]);
    const after = diffPath(header.match(/^\+\+\+ (.+)$/m)?.[1]);
    const renamedFrom = header.match(/^rename from (.+)$/m)?.[1];
    const renamedTo = header.match(/^rename to (.+)$/m)?.[1];
    const oldPath = before === 'dev/null' ? undefined : before ?? renamedFrom;
    const newPath = after === 'dev/null' ? undefined : after ?? renamedTo;
    if (!oldPath && !newPath) return undefined;
    if ((before === undefined || after === undefined) && !(renamedFrom && renamedTo)) return undefined;
    const kind: AgentFileChange['kind'] = before === 'dev/null' ? 'added' : after === 'dev/null' ? 'deleted'
      : oldPath && newPath && oldPath !== newPath ? 'renamed' : 'modified';
    // Copilot removes an absolute path's leading slash when constructing Git diff headers.
    const originalPath = (path: string) => paths.find(candidate => candidate === path || candidate === `/${path}`) ?? path;
    files.push({path: originalPath(newPath ?? oldPath!), kind, diff,
      ...(kind === 'renamed' && oldPath ? {previousPath: originalPath(oldPath)} : {})});
  }
  return files.length ? files : undefined;
}

function diffPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {value = JSON.parse(value) as string;} catch {return undefined;}
  }
  if (value === '/dev/null') return 'dev/null';
  return value?.replace(/^[ab]\//, '') || undefined;
}
