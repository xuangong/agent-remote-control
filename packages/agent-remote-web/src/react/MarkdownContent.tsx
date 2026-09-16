import { useId, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { MarkdownResourceImage, markLocalMarkdownImages, type MarkdownResourceContext } from './markdown-resources.js';

export interface MarkdownContentProps {
  readonly markdown: string;
  readonly className?: string;
  readonly sourceLocator?: string;
  readonly resourceContext?: MarkdownResourceContext;
}

const components: Components = {
  img: ({ alt }) => <span>{alt}</span>,
  table: ({ children }) => <div className="agent-markdown-table" role="region" aria-label="Markdown table" tabIndex={0}>
    <table>{children}</table>
  </div>,
};

export function MarkdownContent({ markdown, className, sourceLocator, resourceContext }: MarkdownContentProps) {
  const id = useId();
  const prefix = `agent-markdown-${id}-`;
  const scopedComponents = useMemo<Components>(() => ({
    ...components,
    img: ({ node, alt }) => <MarkdownResourceImage node={node} alt={alt} context={resourceContext} sourceLocator={sourceLocator} />,
    a: ({ node, href, children, 'aria-describedby': describedBy, ...props }) => href
      ? <a {...props} href={href} rel="noreferrer" aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}>{children}</a>
      : <>{children}</>,
    h2: ({ node, id: headingId, ...props }) => <h2 {...props} id={headingId === 'footnote-label' ? `${prefix}footnote-label` : headingId} />,
  }), [prefix, resourceContext, sourceLocator]);

  return <div className={`agent-markdown${className ? ` ${className}` : ''}`}>
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[markLocalMarkdownImages]} remarkRehypeOptions={{ clobberPrefix: prefix }} components={scopedComponents} urlTransform={safeLink}>{markdown}</Markdown>
  </div>;
}

function safeLink(value: string): string | undefined {
  if (value.startsWith('/') || value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
