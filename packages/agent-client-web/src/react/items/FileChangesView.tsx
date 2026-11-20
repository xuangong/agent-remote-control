import { isAgentFileChangesResult, type AgentFileChange, type AgentToolResultJson } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '../locale.js';
import { diffLines } from './diff-lines.js';

const labelKeys = { added: 'timeline.files.added', modified: 'timeline.files.modified', deleted: 'timeline.files.deleted', renamed: 'timeline.files.renamed', unknown: 'timeline.files.change' } as const;

export function readFileChanges(value: AgentToolResultJson, allowLegacy: boolean): readonly AgentFileChange[] | undefined {
  if (isAgentFileChangesResult(value)) return value.files;
  // Older edit results exposed plain path/diff records. Native metadata stays in Raw result.
  if (allowLegacy && Array.isArray(value) && value.length && value.every(file => file && typeof file === 'object' && !Array.isArray(file)
    && typeof file.path === 'string' && file.path && typeof file.diff === 'string')) {
    return value.map(file => {
      const record = file as { path: string; diff: string };
      return { path: record.path, diff: record.diff, kind: 'unknown' };
    });
  }
  return undefined;
}

export function FileChangesView({ files }: { files: readonly AgentFileChange[] }) {
  const t = useTranslate();
  return <section className="agent-file-changes" aria-label={t('timeline.files.title')}>
    {files.length === 0 ? <p>{t('timeline.files.none')}</p> : files.map((file, index) => {
      const lines = diffLines(file.diff);
      const added = lines.filter(line => line.kind === 'added').length;
      const deleted = lines.filter(line => line.kind === 'deleted').length;
      return <details className="agent-file-change" key={`${index}:${file.path}`} open={index === 0}>
        <summary>
          <span className="agent-file-chevron" aria-hidden="true">▸</span>
          <span className="agent-file-identity"><span>{t(labelKeys[file.kind])}</span><code>{file.path}</code>
            {file.previousPath ? <small>{t('timeline.files.from')} <code>{file.previousPath}</code></small> : null}
          </span>
          <span className="agent-diff-stats" aria-label={t('timeline.files.lineCounts', { added, deleted })}>
            <span>+{added}</span><span>−{deleted}</span>
          </span>
        </summary>
        {lines.length ? <div className="agent-diff-scroll" role="region" aria-label={t('timeline.files.diffFor', { path: file.path })} tabIndex={0}>
          <div className="agent-diff-lines">{lines.map((line, lineIndex) => <div className="agent-diff-line" data-line-kind={line.kind} key={lineIndex}>
            <span className="agent-diff-line-number" data-old-line={line.oldLine}>{line.oldLine ?? ''}</span>
            <span className="agent-diff-line-number" data-new-line={line.newLine}>{line.newLine ?? ''}</span>
            <code>{line.text || '\u00a0'}</code>
          </div>)}</div>
        </div> : <p className="agent-diff-empty">{t('timeline.files.noDiff')}</p>}
      </details>;
    })}
  </section>;
}

export function FileChangesPreview({ files }: { files: readonly AgentFileChange[] }) {
  const t = useTranslate();
  return <section className="agent-file-changes agent-file-previews" aria-label={t('timeline.files.preview')}>
    {files.length === 0 ? <p>{t('timeline.files.none')}</p> : files.slice(0, 3).map((file, index) => {
      const lines = diffLines(file.diff);
      const added = lines.filter(line => line.kind === 'added').length;
      const deleted = lines.filter(line => line.kind === 'deleted').length;
      const firstHunk = Math.max(0, lines.findIndex(line => line.kind === 'hunk'));
      return <div className="agent-file-preview" key={`${index}:${file.path}`}>
        <header><span className="agent-file-identity"><span>{t(labelKeys[file.kind])}</span><code>{file.path}</code>
          {file.previousPath ? <small>{t('timeline.files.from')} <code>{file.previousPath}</code></small> : null}</span>
          <span className="agent-diff-stats" aria-label={t('timeline.files.lineCounts', { added, deleted })}><span>+{added}</span><span>−{deleted}</span></span>
        </header>
        {lines.length ? <div className="agent-diff-scroll agent-diff-preview" role="region" aria-label={t('timeline.files.diffPreviewFor', { path: file.path })} tabIndex={0}>
          <div className="agent-diff-lines">{lines.slice(firstHunk, firstHunk + 6).map((line, lineIndex) => <div className="agent-diff-line agent-preview-line" data-line-kind={line.kind} key={lineIndex}>
            <span className="agent-diff-line-number">{line.oldLine ?? ''}</span><span className="agent-diff-line-number">{line.newLine ?? ''}</span><code>{line.text || '\u00a0'}</code>
          </div>)}</div>
        </div> : <p className="agent-diff-empty">{t('timeline.files.noDiff')}</p>}
      </div>;
    })}
    {files.length > 3 ? <small>{t('timeline.files.more', { count: files.length - 3 })}</small> : null}
  </section>;
}
