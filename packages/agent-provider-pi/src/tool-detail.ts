import { boundToolResult, type AgentToolDetail, type AgentToolResult, type AgentToolResultContent } from '@orchardworks/agent-provider-sdk';
import { list, num, record, str } from './native.js';

/** What a pi tool call does, in the terms the shared tool rows use. Tools the adapter does not know keep their name and arguments. */
export function toolDetail(name: string, args: unknown, cwd?: string): AgentToolDetail {
  const input = record(args);
  switch (name) {
    case 'bash': return { type: 'shell', command: str(input.command) ?? '', ...(cwd ? { cwd } : {}) };
    case 'read': return { type: 'read', filePath: str(input.path) ?? '' };
    case 'edit': return { type: 'edit', filePath: str(input.path) ?? '' };
    case 'write': return { type: 'write', filePath: str(input.path) ?? '' };
    case 'grep': return { type: 'search', query: str(input.pattern) ?? '' };
    case 'find': return { type: 'search', query: str(input.pattern) ?? '' };
    case 'ls': return { type: 'other', description: `List ${str(input.path) ?? '.'}` };
    default: return { type: 'other', description: `${name} ${JSON.stringify(args ?? {})}`.slice(0, 500) };
  }
}

/** One line a person reads in an approval: what the tool is about to do. */
export function toolSummary(name: string, detail: AgentToolDetail): string {
  switch (detail.type) {
    case 'shell': return `Run: ${detail.command}`.slice(0, 500);
    case 'read': return `Read ${detail.filePath}`;
    case 'edit': return `Edit ${detail.filePath}`;
    case 'write': return `Write ${detail.filePath}`;
    case 'search': return `Search for ${detail.query}`.slice(0, 500);
    case 'fetch': return `Fetch ${detail.url}`;
    default: return `${name}: ${detail.description}`.slice(0, 500);
  }
}

/** The text blocks of a pi tool result (`{content: [{type: 'text', text}], details?}`); images are named, not carried. */
export function toolResult(result: unknown, shell: boolean): AgentToolResult {
  const native = record(result);
  const content: AgentToolResultContent[] = [];
  for (const block of list(native.content)) {
    const part = record(block);
    if (part.type === 'text' && typeof part.text === 'string') content.push({ type: 'text', text: part.text, ...(shell ? { stream: 'combined' as const } : {}) });
    else if (part.type === 'image') content.push({ type: 'text', text: '[image]' });
  }
  const details = record(native.details);
  const exitCode = num(details.exitCode);
  return boundToolResult({ content, ...(exitCode !== undefined ? { exitCode } : {}), ...(details.truncation ? { truncated: true } : {}) });
}
