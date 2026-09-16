import type { AgentToolResult } from '@agent-remote-controller/agent-remote-protocol';
import { FileChangesView, readFileChanges } from './FileChangesView.js';

export function ToolResultView({ result, fileEdit = false }: { readonly result: AgentToolResult; readonly fileEdit?: boolean }) {
  return <section className="agent-tool-result" aria-label="Tool result">
    <header className="agent-tool-result-header">
      <strong>Result</strong>
      {result.exitCode !== undefined ? <span>Exit code {result.exitCode}</span> : null}
      {result.durationMs !== undefined ? <span>{result.durationMs} ms</span> : null}
    </header>
    {result.content.length === 0 ? <p>No output.</p> : result.content.map((block, index) => {
      const changes = block.type === 'json' ? readFileChanges(block.value, fileEdit) : undefined;
      return <div className="agent-tool-result-block" key={index}>
      {block.type === 'text' && block.stream ? <small>{block.stream === 'combined' ? 'Output' : block.stream}</small> : null}
      {changes ? <><FileChangesView files={changes} /><details className="agent-file-raw"><summary>Raw result</summary><pre tabIndex={0}>{JSON.stringify(block.type === 'json' ? block.value : null, null, 2)}</pre></details></>
        : <pre tabIndex={0}>{block.type === 'text' ? block.text : JSON.stringify(block.value, null, 2)}</pre>}
    </div>;
    })}
    {result.truncated ? <p className="agent-tool-result-note">Result truncated to fit the timeline.</p> : null}
  </section>;
}
