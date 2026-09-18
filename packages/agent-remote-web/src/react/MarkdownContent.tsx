import { createContext, useContext, useId, useMemo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import { FilePreviewContext } from './FilePreviewContext.js';
import { MarkdownResourceImage, markLocalMarkdownResources, type MarkdownResourceContext } from './markdown-resources.js';

export interface MarkdownContentProps {
  readonly markdown: string;
  readonly className?: string;
  readonly sourceLocator?: string;
  readonly resourceContext?: MarkdownResourceContext;
}

const MarkdownContext = createContext<Pick<MarkdownContentProps, 'resourceContext' | 'sourceLocator'> & { prefix?: string }>({});

const components: Components = {
  a: function Link({ node, href, children, 'aria-describedby': describedBy, ...props }) {
      const preview = useContext(FilePreviewContext);
      const { resourceContext, sourceLocator, prefix } = useContext(MarkdownContext);
      const locator = (node?.data as { localResourceLocator?: string } | undefined)?.localResourceLocator;
      if (locator) return preview && resourceContext
        ? <button type="button" className="agent-resource-link" title={locator} onClick={() => preview.open({ locator, sourceLocator, context: resourceContext })}>{children}</button>
        : <span title={`Local file: ${locator}`}>{children}</span>;
      return href ? <a {...props} href={href} rel="noreferrer" aria-describedby={describedBy === 'footnote-label' ? `${prefix}footnote-label` : describedBy}>{children}</a> : <>{children}</>;
    },

  img: function Image({ node, alt }) {
    const { resourceContext, sourceLocator } = useContext(MarkdownContext);
    return <MarkdownResourceImage node={node} alt={alt} context={resourceContext} sourceLocator={sourceLocator} />;
  },
  table: ({ children }) => <div className="agent-markdown-table" role="region" aria-label="Markdown table" tabIndex={0}>
    <table>{children}</table>
  </div>,
};

export function MarkdownContent({ markdown, className, sourceLocator, resourceContext }: MarkdownContentProps) {
  const id = useId();
  const prefix = `agent-markdown-${id}-`;
  const scopedComponents = useMemo<Components>(() => ({
    ...components,
    h2: ({ node, id: headingId, ...props }) => <h2 {...props} id={headingId === 'footnote-label' ? `${prefix}footnote-label` : headingId} />,
  }), [prefix]);

  const markdownContext = useMemo(() => ({ resourceContext, sourceLocator, prefix }), [resourceContext, sourceLocator, prefix]);
  return <MarkdownContext.Provider value={markdownContext}><div className={`agent-markdown${className ? ` ${className}` : ''}`}>
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]} rehypePlugins={[markLocalMarkdownResources]} remarkRehypeOptions={{ clobberPrefix: prefix }} components={scopedComponents} urlTransform={safeLink}>{markdown}</Markdown>
  </div></MarkdownContext.Provider>;
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
