import type { AgentToolResult } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '../locale.js';
import { FileChangesView, readFileChanges } from './FileChangesView.js';

export function ToolResultView({ result, fileEdit = false }: { readonly result: AgentToolResult; readonly fileEdit?: boolean }) {
  const t = useTranslate();
  return <section className="agent-tool-result" aria-label={t('timeline.result.title')}>
    <header className="agent-tool-result-header">
      <strong>{t('timeline.result.heading')}</strong>
      {result.exitCode !== undefined ? <span>{t('timeline.result.exitCode', { code: result.exitCode })}</span> : null}
      {result.durationMs !== undefined ? <span>{result.durationMs} ms</span> : null}
    </header>
    {result.content.length === 0 ? <p>{t('timeline.result.noOutput')}</p> : result.content.map((block, index) => {
      const changes = block.type === 'json' ? readFileChanges(block.value, fileEdit) : undefined;
      return <div className="agent-tool-result-block" key={index}>
      {block.type === 'text' && block.stream ? <small>{block.stream === 'combined' ? t('timeline.result.output') : block.stream}</small> : null}
      {changes ? <><FileChangesView files={changes} /><details className="agent-file-raw"><summary>{t('timeline.result.raw')}</summary><pre tabIndex={0}>{JSON.stringify(block.type === 'json' ? block.value : null, null, 2)}</pre></details></>
        : <pre tabIndex={0}>{block.type === 'text' ? block.text : JSON.stringify(block.value, null, 2)}</pre>}
    </div>;
    })}
    {result.truncated ? <p className="agent-tool-result-note">{t('timeline.result.truncated')}</p> : null}
  </section>;
}
