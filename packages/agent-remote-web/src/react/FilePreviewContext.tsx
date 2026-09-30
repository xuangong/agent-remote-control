import { createContext } from 'react';
import type { MarkdownResourceContext } from './markdown-resources.js';

export interface FilePreviewRequest {
  readonly locator: string;
  readonly returnFocus?: HTMLElement;
  readonly sourceLocator?: string;
  readonly context: MarkdownResourceContext;
}

export const FilePreviewContext = createContext<{
  /** Invalidates open previews when the surrounding conversation view changes. */
  readonly scopeKey?: string;
  open(request: FilePreviewRequest): void;
} | undefined>(undefined);
