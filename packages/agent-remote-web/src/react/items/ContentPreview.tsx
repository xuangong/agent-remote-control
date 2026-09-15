/** Preview only supplied text; never infer results or render partial HTML/Markdown. */
export function ContentPreview({ text, code = false }: { text: string; code?: boolean }) {
  const lines = text.slice(0, 2400).split(/\r?\n/).slice(0, 6);
  return code ? <pre className="agent-content-preview agent-code-preview" tabIndex={0}>{lines.map((line, index) =>
    <span className="agent-preview-line" key={index}>{line || '\u00a0'}{'\n'}</span>)}</pre>
    : <div className="agent-content-preview agent-text-preview">{lines.join('\n')}</div>;
}
