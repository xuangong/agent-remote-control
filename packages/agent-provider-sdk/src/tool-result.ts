export type AgentToolResultJson = null | boolean | number | string | AgentToolResultJson[] | { [key: string]: AgentToolResultJson };
export type AgentToolResultContent =
  | { type: 'text'; text: string; stream?: 'stdout' | 'stderr' | 'combined' }
  | { type: 'json'; value: AgentToolResultJson };

export interface AgentToolResult {
  content: AgentToolResultContent[];
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
}

export const TOOL_RESULT_MAX_CHARS = 64 * 1024;
export const TOOL_RESULT_MAX_BLOCKS = 128;

/** Result bodies are bounded snapshots; consumers replace them instead of appending. */
export function boundToolResult(result: AgentToolResult): AgentToolResult {
  const content: AgentToolResultContent[] = [];
  let remaining = TOOL_RESULT_MAX_CHARS;
  let truncated = result.truncated ?? false;
  for (const block of result.content) {
    if (content.length === TOOL_RESULT_MAX_BLOCKS || remaining === 0) { truncated = true; break; }
    const text = block.type === 'text' ? block.text : JSON.stringify(block.value);
    if (text.length > remaining) {
      let end = remaining;
      if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
      content.push(block.type === 'text' ? { ...block, text: text.slice(0, end) } : { type: 'text', text: text.slice(0, end) });
      truncated = true;
      break;
    }
    content.push(block.type === 'text' ? { ...block } : { type: 'json', value: JSON.parse(text) as AgentToolResultJson });
    remaining -= text.length;
  }
  return { ...result, content, ...(truncated ? { truncated: true } : {}) };
}
