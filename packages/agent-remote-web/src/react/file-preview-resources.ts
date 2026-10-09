import type { MarkdownResourceContext } from './local-resource.js';

export function createFilePreviewResourceContext(
  context: MarkdownResourceContext,
  documentLocator: string,
  sourceLocator: string | undefined,
  scopeKey: string,
): MarkdownResourceContext {
  const directoryEnd = Math.max(documentLocator.lastIndexOf('/'), documentLocator.lastIndexOf('\\')) + 1;
  return {
    ...context,
    scopeKey,
    resolveResource(locator, source) {
      if (source !== documentLocator || !isRelativeLocator(documentLocator) || !isRelativeLocator(locator)) {
        return context.resolveResource(locator, source === documentLocator ? localSourceLocator(source) : source);
      }
      // Keep encoded characters and parent segments for the Host's path policy.
      return context.resolveResource(documentLocator.slice(0, directoryEnd) + locator, sourceLocator);
    },
  };
}

function isRelativeLocator(locator: string): boolean {
  return !!locator && !/^[/\\]|^[a-z][a-z\d+.-]*:/i.test(locator);
}

function localSourceLocator(locator: string): string {
  if (!/^[/\\]|^[a-z]:[/\\]/i.test(locator)) return locator;
  // The Host decodes file locators but uses ordinary source paths directly.
  try { return decodeURI(locator); } catch { return locator; }
}
