import type { AgentToolDetail } from '@borgee/agent-provider-sdk';

import { isRecord, nonEmptyString } from './native.js';

export interface DshToolPresentation {
  content?: unknown;
}

export interface DshTool {
  presentCall?(argumentsValue: unknown): DshToolPresentation | undefined;
  presentResult?(argumentsValue: unknown, result: unknown): DshToolPresentation | undefined;
}

export interface DshToolRegistry {
  get(name: string): DshTool | undefined;
}

export function projectDshToolDetails(name: string, argumentsValue: unknown): AgentToolDetail {
  const args = isRecord(argumentsValue) ? argumentsValue : {};
  const command = nonEmptyString(args.command) ?? nonEmptyString(args.cmd);
  if ((name === 'bash' || name === 'shell' || name === 'terminal') && command) {
    const cwd = nonEmptyString(args.cwd);
    return { type: 'shell', command, ...(cwd ? { cwd } : {}) };
  }
  const filePath = nonEmptyString(args.file_path) ?? nonEmptyString(args.path);
  if ((name === 'read' || name === 'read_image') && filePath) return { type: 'read', filePath };
  if (name === 'edit' && filePath) return { type: 'edit', filePath };
  if (name === 'write' && filePath) return { type: 'write', filePath };
  const query = nonEmptyString(args.query) ?? nonEmptyString(args.pattern);
  if ((name === 'search' || name === 'grep') && query) return { type: 'search', query };
  const url = nonEmptyString(args.url);
  if ((name === 'fetch' || name === 'web_fetch') && url) return { type: 'fetch', url };
  return { type: 'other', description: `DSH tool ${name}` };
}
