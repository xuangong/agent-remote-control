import type { AgentTimelineItem, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { fromMarkdown } from 'mdast-util-from-markdown';

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: readonly MarkdownNode[];
}

/** Attachments belong to the conversation; images already in its prose need no second preview. */
export function messageResources(item: AgentTimelineItem, bindings: readonly ResourceBinding[], rendersMarkdownImages: boolean) {
  const labels = new Map<string, string>();
  if (item.type !== 'user_message' && item.type !== 'assistant_message' && item.type !== 'agent_communication') {
    return { bindings: [], labels };
  }
  const markdown: string[] = [];
  if (item.type === 'user_message' && item.content?.some(part => part.type === 'image')) {
    for (const part of item.content) {
      if (part.type === 'image') labels.set(part.locator, part.label);
      else markdown.push(part.text);
    }
  } else markdown.push(item.text);
  if (!rendersMarkdownImages || bindings.length === 0) return { bindings, labels };
  const inlineImages = new Set(markdown.flatMap(text => [...markdownImages(text)]));
  return { bindings: bindings.filter(binding => !inlineImages.has(binding.locator)), labels };
}

function markdownImages(markdown: string): Set<string> {
  const images = new Set<string>();
  if (!markdown.includes('![')) return images;
  const references = new Set<string>();
  const definitions = new Map<string, string>();
  function visit(node: MarkdownNode): void {
    if (node.type === 'image' && node.url) images.add(node.url);
    if (node.type === 'imageReference' && node.identifier) references.add(node.identifier);
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    node.children?.forEach(visit);
  }
  visit(fromMarkdown(markdown));
  for (const reference of references) {
    const locator = definitions.get(reference);
    if (locator) images.add(locator);
  }
  return images;
}
