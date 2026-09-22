import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';
import { codexImagePlaceholderLabel } from './message-content.js';

export interface CodexPromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }

/** Resolve the same persisted turn boundary used by the 0.155.1 Esc editor. */
export async function preparePromptEdit(
  transport: Pick<CodexAppServerTransport, 'request'>,
  target: CodexPromptEditTarget,
  initialization: unknown,
): Promise<{ beforeTurnId?: string; cwd?: string; model?: string }> {
  const userAgent = isRecord(initialization) ? readString(initialization.userAgent) : undefined;
  if (!userAgent || !/\/0\.155\.1(?:\s|\(|$)/.test(userAgent)) {
    throw new Error('Prompt editing has not been verified for this Codex app-server version. Use Esc in its matching CLI.');
  }
  const metadata = await transport.request('thread/read', { threadId: target.nativeSessionId, includeTurns: false });
  if (!isRecord(metadata) || !isRecord(metadata.thread) || metadata.thread.id !== target.nativeSessionId) throw new Error('The source conversation is unavailable.');
  const thread = metadata.thread;
  if (isRecord(thread.source) && 'subAgent' in thread.source) throw new Error('Editing previous prompts is unavailable in native child conversations.');
  let cursor: string | undefined;
  const seen = new Set<string>();
  const deadline = Date.now() + 25_000;
  for (let pageIndex = 0; pageIndex < 500 && Date.now() < deadline; pageIndex++) {
    const result = await transport.request('thread/turns/list', {
      threadId: target.nativeSessionId, limit: 10, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
    });
    if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 10 || result.data.some(turn => !isRecord(turn) || !readString(turn.id) || !Array.isArray(turn.items))) throw new Error('Codex returned invalid prompt history.');
    const next = readString(result.nextCursor);
    if ((result.nextCursor != null && !next) || (next && seen.has(next))) throw new Error('Codex prompt history did not advance.');
    const index = result.data.findIndex(turn => turn.id === target.turnId);
    if (index !== -1) {
      const turn = result.data[index]!;
      if (!['completed', 'interrupted', 'failed'].includes(turn.status)) throw new Error('Wait for this turn to finish before editing its prompt.');
      if (turn.items.some((item: unknown) => isRecord(item) && ['enteredReviewMode', 'exitedReviewMode'].includes(String(item.type)))) throw new Error('Review prompts cannot be edited here. Use the matching Codex CLI.');
      const firstPrompt = turn.items.find((item: unknown) => isRecord(item) && item.type === 'userMessage');
      if (!isRecord(firstPrompt) || firstPrompt.id !== target.messageId) throw new Error('This message is no longer available or is a mid-turn steer. Only the first prompt of a turn can be edited.');
      if (!Array.isArray(firstPrompt.content) || firstPrompt.content.length === 0 || firstPrompt.content.some((part, index, content) => !isRecord(part)
        || !['text', 'localImage', 'image'].includes(String(part.type))
        || part.type === 'text' && (typeof part.text !== 'string' || Array.isArray(part.text_elements) && part.text_elements.length > 0
          && codexImagePlaceholderLabel(part, content[index + 1]) === undefined))) {
        throw new Error('This prompt contains native input bindings that cannot be restored in the web composer. Edit it in the Codex CLI.');
      }
      return { ...(index + 1 < result.data.length || next ? { beforeTurnId: target.turnId } : {}),
        ...(readString(thread.cwd) ? { cwd: readString(thread.cwd) } : {}),
        ...(readString(metadata.model) ? { model: readString(metadata.model) } : {}) };
    }
    if (!next) throw new Error('The selected message is no longer in this conversation. Reload before editing.');
    seen.add(next); cursor = next;
  }
  throw new Error('The selected prompt could not be verified within the history deadline. Use Esc in the Codex CLI.');
}
