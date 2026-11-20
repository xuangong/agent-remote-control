import type { SessionFile } from '@orchardworks/agent-client';
import { useTranslate } from '@orchardworks/agent-client-web/react';

const fileName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;

/** The files the loaded conversation changed or shared, newest first; a changed file that still exists opens in the file preview. */
export function FilesList({ files, onOpen }: { files: readonly SessionFile[]; onOpen?(file: SessionFile, trigger: HTMLElement): void }) {
  const t = useTranslate();
  if (!files.length) return <p className="lab-assistant-empty">{t('details.noFiles')}</p>;
  const kind = (file: SessionFile) => file.source !== 'change' ? t('details.fileShared')
    : file.change === 'added' ? t('details.fileAdded') : file.change === 'deleted' ? t('details.fileDeleted') : file.change === 'renamed' ? t('details.fileRenamed') : t('details.fileModified');
  return <ul className="lab-assistant-files">
    {files.map(file => {
      const counts = file.additions || file.deletions ? <span className="lab-assistant-file-counts" aria-hidden="true">+{file.additions ?? 0} −{file.deletions ?? 0}</span> : null;
      const content = <><span className="lab-assistant-file-name">{fileName(file.path)}</span>
        <span className="lab-assistant-file-meta">{kind(file)}{counts}</span></>;
      return <li key={`${file.source}:${file.path}`} data-change={file.change}>
        {onOpen && file.source === 'change' && file.change !== 'deleted' ? <button type="button" title={file.path} onClick={event => onOpen(file, event.currentTarget)}>{content}</button>
          : <span title={file.path}>{content}</span>}
      </li>;
    })}
  </ul>;
}
