/** Views and helpers that tests of other packages mount or observe directly: the status line, the session settings, the reading anchor and the image draft store. */
export { AgentActivityStatus, type AgentActivityStatusProps } from './react/AgentActivityStatus.js';
export { AgentSessionSettings, type SessionControlView } from './react/AgentSessionSettings.js';
export { captureReadingText, readingTextTop, type ReadingTextAnchor } from './react/reading-text-anchor.js';
export { useImageDraft } from './react/useImageDraft.js';
/** The image draft store as one module, so a test can observe the writes the composer makes. */
export * as imageDraftStorage from './image-drafts.js';
