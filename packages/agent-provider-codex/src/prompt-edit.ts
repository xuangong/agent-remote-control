import type { CodexAppServerTransport } from './app-server-transport.js';
import { isRecord, readString } from './native.js';
import { codexImagePlaceholderLabel } from './message-content.js';

export interface CodexPromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }

/** Resolve an editable persisted boundary from native history, independently of CLI version. */
export async function preparePromptEdit(
  transport: Pick<CodexAppServerTransport, 'request'>,
  target: CodexPromptEditTarget,
): Promise<{ beforeTurnId?: string; previousTurnId?: string; cwd?: string; model?: string }> {
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
      let previousTurn = result.data[index + 1];
      if (!previousTurn && next) {
        const older = await transport.request('thread/turns/list', {
          threadId: target.nativeSessionId, limit: 1, sortDirection: 'desc', itemsView: 'full', cursor: next,
        });
        if (!isRecord(older) || !Array.isArray(older.data) || older.data.length !== 1
          || !isRecord(older.data[0]) || !readString(older.data[0].id) || !Array.isArray(older.data[0].items)) {
          throw new Error('Codex could not verify the preceding turn boundary. Reload before editing.');
        }
        previousTurn = older.data[0];
      }
      if (previousTurn?.id === target.turnId) throw new Error('Codex prompt history did not advance.');
      return { ...(previousTurn ? { beforeTurnId: target.turnId, previousTurnId: previousTurn.id as string } : {}),
        ...(readString(thread.cwd) ? { cwd: readString(thread.cwd) } : {}),
        ...(readString(metadata.model) ? { model: readString(metadata.model) } : {}) };
    }
    if (!next) throw new Error('The selected message is no longer in this conversation. Reload before editing.');
    seen.add(next); cursor = next;
  }
  throw new Error('The selected prompt could not be verified within the history deadline. Use Esc in the Codex CLI.');
}
