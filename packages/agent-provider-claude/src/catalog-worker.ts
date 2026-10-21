import { renameSession, getSessionInfo, getSessionMessages, listSessions, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeHistoryError, readClaudeHistoryPage } from './reference-history.js';
import { withFoldedInput } from './folded-input.js';
import { forkPromptEdit, inspectPromptEdit, promptTurns, readTranscript, verifyPromptEditBranch } from './prompt-edit.js';

const [operation, sessionId, argument] = process.argv.slice(2);
try {
  const result = operation === 'history' && sessionId && argument ? await readHistory(sessionId, argument)
    : operation === 'rename' && sessionId && argument ? await renameSession(sessionId, argument) : operation === 'list' ? await listSessions() : operation === 'info' && sessionId ? await getSessionInfo(sessionId)
    : operation === 'messages' && sessionId ? await getSessionMessages(sessionId)
    : operation === 'timeline-messages' && sessionId ? await timelineMessages(sessionId)
    : operation?.startsWith('prompt-edit-') && sessionId && argument ? await promptEdit(operation, sessionId, argument)
    : operation === 'child-messages' && sessionId && argument ? await getSubagentMessages(sessionId, argument)
    : operation === 'children' && sessionId ? await readChildren(sessionId)
    : (() => { throw new Error('Unknown catalog operation.'); })();
  process.stdout.write(JSON.stringify(result ?? null));
} catch {
  process.stderr.write('Claude native catalog operation failed.\n');
  process.exitCode = 1;
}

async function readHistory(id: string, argument: string) {
  try {
    return { page: await readClaudeHistoryPage({ info: getSessionInfo, messages: async (sessionId, options) => withFoldedInput(sessionId, await getSessionMessages(sessionId, options)) }, id, JSON.parse(argument)) };
  } catch (error) {
    return { error: error instanceof ClaudeHistoryError ? error.message : 'Claude source history is unavailable.' };
  }
}

/** Each message names the turn it belongs to, so a reopened Timeline offers the same prompt edits as a live one. */
async function timelineMessages(id: string) {
  const messages = await withFoldedInput(id, await getSessionMessages(id));
  const turns = promptTurns(await readTranscript(id) ?? []);
  return messages.map(message => { const turnId = turns.get(message.uuid); return turnId ? { ...message, turnId } : message; });
}

/** Validation failures are user-facing explanations; anything else stays a generic catalog failure. */
async function promptEdit(operation: string, id: string, argument: string) {
  const { target, candidate } = JSON.parse(argument);
  try {
    if (operation === 'prompt-edit-inspect') return { result: await inspectPromptEdit(id, target) };
    if (operation === 'prompt-edit-fork') return { result: await forkPromptEdit(id, target) };
    if (operation === 'prompt-edit-verify') { await verifyPromptEditBranch(id, target, candidate); return { result: true }; }
  } catch (error) { return { error: error instanceof Error ? error.message : 'Claude prompt editing is unavailable.' }; }
  throw new Error('Unknown catalog operation.');
}

async function readChildren(parentId: string) {
  const children = [];
  for (const id of await listSubagents(parentId)) children.push({ id, messages: await getSubagentMessages(parentId, id) });
  return children;
}
