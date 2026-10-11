import type { SessionInfo, SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo, SessionPromptInput, SessionStructuredError, TokenUsageInfo } from '@opencode/client';

/** Native v2 records remain intact until the adapter projects their public meaning. */
export type NativeMessage = SessionMessageInfo;
export type NativeAssistant = SessionMessageAssistant;
export type NativeTool = SessionMessageAssistantTool;
export type NativeSession = SessionInfo;
export type NativeTokenUsage = TokenUsageInfo;
export type NativeError = SessionStructuredError;
export type NativeInput = Pick<SessionPromptInput, 'text' | 'files'>;

/** The owning message supplies attachment identity; v2 attachments have no native ID. */
export interface NativeAttachment {
  key: string;
  mime: string;
  name?: string | null;
  data?: string;
  uri?: string;
}

/** A native user begins a turn; additional inputs before idle are steers in that turn. */
export function turnIds(messages: readonly NativeMessage[], options: { startsAtBeginning?: boolean } = {}): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let turnId: string | undefined;
  let boundaryKnown = options.startsAtBeginning ?? false;
  for (const message of messages) {
    if (message.type === 'idle') {
      if (turnId) result.set(message.id, turnId);
      turnId = undefined;
      boundaryKnown = true;
      continue;
    }
    if (message.type === 'user' && !turnId && boundaryKnown) turnId = message.id;
    if (turnId) result.set(message.id, turnId);
  }
  return result;
}
