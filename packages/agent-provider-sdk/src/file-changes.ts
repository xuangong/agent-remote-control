import { boundToolResult, type AgentToolResult } from './tool-result.js';

export interface AgentFileChange {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  previousPath?: string;
  diff: string;
}

/** A versioned presentation format within the existing JSON result channel. */
export function fileChangesResult(files: AgentFileChange[]): AgentToolResult {
  return boundToolResult({ content: [{ type: 'json', value: {
    format: 'file_changes', version: 1, files: files.map(file => ({ ...file })),
  } }] });
}
