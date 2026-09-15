import type { AgentToolResult } from '@borgee/agent-remote-protocol';
import { ContentPreview } from './ContentPreview.js';
import { FileChangesPreview, readFileChanges } from './FileChangesView.js';

export function ToolResultPreview({ result, fileEdit, search = false }: { result: AgentToolResult; fileEdit: boolean; search?: boolean }) {
  return <div className="agent-tool-result-preview">
    {result.exitCode !== undefined ? <small>Exit code {result.exitCode}</small> : null}
    {result.content.length ? result.content.slice(0, 2).map((block, index) => {
      if (search && block.type === 'json' && Array.isArray(block.value) && block.value.length === 0) return <p key={index}>No results.</p>;
      if (block.type === 'text' && !block.text.trim()) return <p key={index}>No output.</p>;
      const files = block.type === 'json' ? readFileChanges(block.value, fileEdit) : undefined;
      return files ? <FileChangesPreview files={files} key={index} />
        : <ContentPreview key={index} code text={block.type === 'text' ? block.text : JSON.stringify(block.value, null, 2)} />;
    }) : <p>No output.</p>}
    {result.content.length > 2 ? <small>{result.content.length - 2} more output blocks</small> : null}
    {result.truncated ? <small>Result truncated to fit the timeline.</small> : null}
  </div>;
}
