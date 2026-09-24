import type { AgentToolDetail } from '@orchardworks/agent-provider-sdk';
import {patchFiles} from './tool-result.js';
export const provider = 'copilot';
export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function detail(name: string, value: unknown): AgentToolDetail {
  if (name === 'apply_patch') {
    const files = patchFiles(value).filter(file => file.operation !== 'Move to');
    if (files.length === 1) return {type: files[0]!.operation === 'Add File' ? 'write' : 'edit', filePath: files[0]!.path};
    if (files.length > 1) return {type: 'other', description: `Edit ${files.length} files`};
  }
  const args = record(value);
  const command = args.command ?? args.fullCommandText;
  if (typeof command === 'string') return { type: 'shell', command };
  const path = args.path ?? args.file_path ?? args.fileName;
  if (typeof path === 'string') return { type: /edit|patch/i.test(name) ? 'edit' : /write|create/i.test(name) ? 'write' : 'read', filePath: path };
  return { type: 'other', description: name };
}
