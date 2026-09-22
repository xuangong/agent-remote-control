import type { AgentTimelineItem } from '@orchardworks/agent-remote-protocol';
import { loadLocalResource, type MarkdownResourceContext } from './local-resource.js';
import { type ImageDraft, writeImageDraft, cacheDraftImage, imageDraftScopeGeneration } from '../image-drafts.js';
import { draftText } from './composer-document.js';
export async function preparePromptDraft(item: Extract<AgentTimelineItem, { type: 'user_message' }>, context: MarkdownResourceContext): Promise<Omit<ImageDraft, 'key' | 'scope'>> {
  const draft: Omit<ImageDraft, 'key' | 'scope'> = { version: 1, parts: [], images: {}, nextLabel: 1 };
  let bytes = 0;
  for (const part of item.content ?? [{ type: 'text', text: item.text }]) {
    if (part.type === 'text') { draft.parts.push({ ...part }); continue; }
    const { detail } = await loadLocalResource(context, part.locator);
    if (!detail || detail.status !== 'available' || !('contentBase64' in detail) || !detail.mediaType || !['image/png', 'image/jpeg', 'image/webp'].includes(detail.mediaType)) throw new Error('An image from this prompt is unavailable. Open the original prompt in Codex to edit it.');
    const blob = new Blob([Uint8Array.from(atob(detail.contentBase64), value => value.charCodeAt(0))], { type: detail.mediaType });
    bytes += blob.size;
    if (Object.keys(draft.images).length >= 8 || blob.size > 10 * 1024 * 1024 || bytes > 20 * 1024 * 1024) throw new Error('This prompt exceeds the web composer image limits. Edit it in Codex.');
    const imageId = crypto.randomUUID();
    draft.parts.push({ type: 'image', imageId, label: part.label });
    draft.images[imageId] = { imageId, blob, uploadId: crypto.randomUUID(), status: 'pending', progress: 0 };
    const labelIndex = /^image #(\d+)$/.exec(part.label)?.[1];
    draft.nextLabel = Math.max(draft.nextLabel + 1, labelIndex ? Number(labelIndex) + 1 : 1);
  }
  return draft;
}
export async function savePromptDraft(scope: string, sessionKey: string, draft: Omit<ImageDraft, 'key' | 'scope'>): Promise<string> {
  if (Object.keys(draft.images).length) {
    const generation = imageDraftScopeGeneration(scope);
    await writeImageDraft({ ...draft, key: JSON.stringify([scope, sessionKey]), scope }, generation);
    for (const image of Object.values(draft.images)) if (image.blob) cacheDraftImage(scope, image.imageId, image.blob, generation);
  }
  return draftText(draft.parts);
}
