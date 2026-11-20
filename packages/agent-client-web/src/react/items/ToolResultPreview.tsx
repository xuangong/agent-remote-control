import type { AgentToolResult } from '@orchardworks/agent-remote-protocol';
import { ContentPreview } from './ContentPreview.js';
import { useTranslate } from '../locale.js';
import { FileChangesPreview, readFileChanges } from './FileChangesView.js';

export function ToolResultPreview({ result, fileEdit, search = false }: { result: AgentToolResult; fileEdit: boolean; search?: boolean }) {
  const t = useTranslate();
  return <div className="agent-tool-result-preview">
    {result.exitCode !== undefined ? <small>{t('timeline.result.exitCode', { code: result.exitCode })}</small> : null}
    {result.content.length ? result.content.slice(0, 2).map((block, index) => {
      if (search && block.type === 'json' && Array.isArray(block.value) && block.value.length === 0) return <p key={index}>{t('timeline.result.noResults')}</p>;
      if (block.type === 'text' && !block.text.trim()) return <p key={index}>{t('timeline.result.noOutput')}</p>;
      const files = block.type === 'json' ? readFileChanges(block.value, fileEdit) : undefined;
      return files ? <FileChangesPreview files={files} key={index} />
        : <ContentPreview key={index} code text={block.type === 'text' ? block.text : JSON.stringify(block.value, null, 2)} />;
    }) : <p>{t('timeline.result.noOutput')}</p>}
    {result.content.length > 2 ? <small>{t('timeline.result.moreBlocks', { count: result.content.length - 2 })}</small> : null}
    {result.truncated ? <small>{t('timeline.result.truncated')}</small> : null}
  </div>;
}
