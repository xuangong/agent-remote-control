import type { AgentToolResult } from '@borgee/agent-remote-protocol';

export function ToolResultView({ result }: { readonly result: AgentToolResult }) {
  return <section className="agent-tool-result" aria-label="Tool result">
    <header className="agent-tool-result-header">
      <strong>Result</strong>
      {result.exitCode !== undefined ? <span>Exit code {result.exitCode}</span> : null}
      {result.durationMs !== undefined ? <span>{result.durationMs} ms</span> : null}
    </header>
    {result.content.length === 0 ? <p>No output.</p> : result.content.map((block, index) => <div className="agent-tool-result-block" key={index}>
      {block.type === 'text' && block.stream ? <small>{block.stream === 'combined' ? 'Output' : block.stream}</small> : null}
      <pre tabIndex={0}>{block.type === 'text' ? block.text : JSON.stringify(block.value, null, 2)}</pre>
    </div>)}
    {result.truncated ? <p className="agent-tool-result-note">Result truncated to fit the timeline.</p> : null}
  </section>;
}
