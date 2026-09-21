import { Fragment, useContext, useState } from 'react';
import { FilePreviewContext } from '../FilePreviewContext.js';
import { ImagePreview } from '../ImagePreview.js';
import { loadLocalResource } from '../local-resource.js';
import { TimelineTitle } from '../TimelineTitle.js';
import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { MarkdownContent } from '../MarkdownContent.js';
import type { MessageGroupPosition } from '../timeline-render-model.js';
import type { MarkdownResourceContext } from '../markdown-resources.js';

type Message = Extract<AgentTimelineItem, { type: 'user_message' | 'assistant_message' }>;

interface MessageItemProps<T extends Message> {
  readonly item: T;
  readonly messageGroup?: MessageGroupPosition;
  readonly resourceContext?: MarkdownResourceContext;
}

export function UserMessageItem({ item, messageGroup, resourceContext }: MessageItemProps<Extract<Message, { type: 'user_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} resourceContext={resourceContext} />;
}

export function AssistantMessageItem({ item, messageGroup, resourceContext }: MessageItemProps<Extract<Message, { type: 'assistant_message' }>>) {
  return <MessageBubble item={item} messageGroup={messageGroup} resourceContext={resourceContext} />;
}

export function MessageItem({ item }: { readonly item: Message }) {
  return item.type === 'user_message'
    ? <UserMessageItem item={item} />
    : <AssistantMessageItem item={item} />;
}

function MessageBubble({ item, messageGroup = 'single', resourceContext }: MessageItemProps<Message>) {
  const user = item.type === 'user_message';
  return <article
    className={`agent-timeline-item agent-message agent-message-${user ? 'user' : 'assistant'} agent-message-group-${messageGroup}`}
    aria-label={user ? 'User message' : 'Assistant message'}
    data-message-group={messageGroup}
  >
    <header className="agent-item-header">
      <TimelineTitle className="agent-item-kicker">{user ? 'You' : 'Assistant'}</TimelineTitle>
    </header>
    {item.type === 'user_message' && item.content?.some(part => part.type === 'image')
      ? <div className="agent-message-ordered-content">{item.content.map((part, index) => part.type === 'text'
        ? <Fragment key={index}><span className="agent-message-part-space">{part.text.match(/^\s*/)?.[0]}</span>{part.text.trim() ? <MarkdownContent markdown={part.text} className="agent-message-text-part" resourceContext={resourceContext} /> : null}<span className="agent-message-part-space">{part.text.trim() ? part.text.match(/\s*$/)?.[0] : null}</span></Fragment>
        : <MessageImageTag key={index} label={part.label} locator={part.locator} context={resourceContext} />)}</div>
      : <MarkdownContent markdown={item.text} resourceContext={resourceContext} />}
  </article>;
}

function MessageImageTag({ label, locator, context }: { label: string; locator: string; context?: MarkdownResourceContext }) {
  const preview = useContext(FilePreviewContext);
  const [blob, setBlob] = useState<Blob>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  async function open(): Promise<void> {
    if (!context) return;
    if (preview) { preview.open({ locator, context, returnFocus: document.activeElement instanceof HTMLElement ? document.activeElement : undefined }); return; }
    setLoading(true); setError(undefined);
    try {
      const { detail } = await loadLocalResource(context, locator);
      if (!detail || detail.status !== 'available' || !('contentBase64' in detail) || !detail.mediaType?.startsWith('image/')) throw new Error('Image preview is unavailable.');
      setBlob(new Blob([Uint8Array.from(atob(detail.contentBase64), value => value.charCodeAt(0))], { type: detail.mediaType }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Image preview is unavailable.'); }
    finally { setLoading(false); }
  }
  return <><button type="button" className="agent-image-tag" aria-label={`Preview ${label}`} aria-busy={loading} disabled={!context || loading}
    title={error ?? `Preview ${label}`} onClick={() => void open()}>[{label}]</button>
    {error ? <span role="alert">{error}</span> : null}
    {blob ? <ImagePreview blob={blob} label={label} onClose={() => setBlob(undefined)} /> : null}</>;
}
