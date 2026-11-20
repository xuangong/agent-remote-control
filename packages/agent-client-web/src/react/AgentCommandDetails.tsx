import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { useEffect, useRef, useState } from 'react';
import type { AgentCommand, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent } from './MarkdownContent.js';
import { useTranslate } from './locale.js';
import { type AgentReplicaState } from '@orchardworks/agent-client';

export interface AgentCommandDetailsProps {
  command: AgentCommand;
  resources: AgentReplicaState['resources'];
  onRequestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  onResolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
  resourceScopeKey?: string;
  onClose(): void;
}

export function AgentCommandDetails({ command, resources, onRequestResource, onResolveResource, resourceScopeKey, onClose }: AgentCommandDetailsProps) {
  const t = useTranslate();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const requestRef = useRef(onRequestResource);
  requestRef.current = onRequestResource;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [revision, retry] = useState(0);
  const binding = command.documentation;
  const resourceId = binding?.resourceId;
  useEffect(() => {
    let current = true;
    setError(undefined);
    if (!binding || !requestRef.current) return;
    setLoading(true);
    void Promise.resolve().then(() => requestRef.current!(binding)).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : t('composer.details.loadFailed'));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [resourceId, revision]);
  const resource = resourceId ? resources[resourceId] : undefined;
  let markdown: string | undefined;
  if (resource?.status === 'available' && 'contentBase64' in resource && typeof resource.contentBase64 === 'string' && ['text/plain', 'text/markdown'].includes(resource.mediaType)) {
    try {
      markdown = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(resource.contentBase64), (character) => character.charCodeAt(0)))
        .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
    } catch { markdown = undefined; }
  }
  return <aside className="agent-command-details" aria-label={command.kind === 'skill' ? t('composer.details.skillLabel') : t('composer.details.commandLabel')}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header><div><small>{command.kind === 'skill' ? t('composer.details.skill') : t('composer.details.command')}</small><h3>{command.name}</h3></div>
      <button ref={closeRef} type="button" aria-label={t('composer.details.close')} onClick={onClose}>×</button></header>
    <div className="agent-command-details-content">
      <p className="agent-command-introduction">{command.description}</p>
      {loading ? <p role="status">{t('composer.details.loading')}</p>
        : markdown !== undefined ? <MarkdownContent markdown={markdown} sourceLocator={binding?.locator}
          resourceContext={binding && onRequestResource && onResolveResource && resourceScopeKey ? {
            scopeKey: resourceScopeKey, bindings: [binding], resources,
            resolveResource: onResolveResource, requestResource: onRequestResource,
          } : undefined} />
        : <p className="agent-composer-note">{error ?? (resource?.status === 'failed' ? resource.message
          : resource?.status === 'unavailable' ? resource.reason
          : !binding || !onRequestResource ? t('composer.details.descriptionOnly')
          : t('composer.details.unavailable'))}</p>}
      {!loading && binding && onRequestResource && markdown === undefined ? <button type="button" onClick={() => retry((value) => value + 1)}>{t('composer.details.retry')}</button> : null}
    </div>
  </aside>;
}
