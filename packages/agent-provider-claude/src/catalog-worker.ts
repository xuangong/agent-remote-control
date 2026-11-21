import { renameSession, getSessionInfo, getSessionMessages, listSessions, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeHistoryError, readClaudeHistoryPage } from './reference-history.js';
import { withTranscriptExtras } from './transcript-extras.js';
import { forkPromptEdit, inspectPromptEdit, promptTurns, readSubagentTranscript, readTranscript, verifyPromptEditBranch } from './prompt-edit.js';

const [operation, sessionId, argument] = process.argv.slice(2);
try {
  const result = operation === 'history' && sessionId && argument ? await readHistory(sessionId, argument)
    : operation === 'rename' && sessionId && argument ? await renameSession(sessionId, argument) : operation === 'list' ? await listSessions() : operation === 'info' && sessionId ? await getSessionInfo(sessionId)
    : operation === 'messages' && sessionId ? await getSessionMessages(sessionId)
    : operation === 'timeline-messages' && sessionId ? await timelineMessages(sessionId)
    : operation === 'transcript-records' && sessionId ? (await timelineMessages(sessionId)).map(message => message.uuid)
    : operation?.startsWith('prompt-edit-') && sessionId && argument ? await promptEdit(operation, sessionId, argument)
    : operation === 'child-messages' && sessionId && argument ? await childMessages(sessionId, argument)
    : operation === 'children' && sessionId ? await readChildren(sessionId)
    : (() => { throw new Error('Unknown catalog operation.'); })();
  process.stdout.write(JSON.stringify(result ?? null));
} catch {
  process.stderr.write('Claude native catalog operation failed.\n');
  process.exitCode = 1;
}

async function readHistory(id: string, argument: string) {
  try {
    return { page: await readClaudeHistoryPage({ info: getSessionInfo, messages: async (sessionId, options) => withTranscriptExtras(sessionId, await getSessionMessages(sessionId, options), await readTranscript(sessionId, process.env, true)) }, id, JSON.parse(argument)) };
  } catch (error) {
    return { error: error instanceof ClaudeHistoryError ? error.message : 'Claude source history is unavailable.' };
  }
}

/** Each message names the turn it belongs to, so a reopened Timeline offers the same prompt edits as a live one. One read of the transcript serves the turns and what the public read leaves out. */
async function timelineMessages(id: string) {
  const rows = await readTranscript(id, process.env, true);
  const messages = withTranscriptExtras(id, await getSessionMessages(id), rows);
  const turns = promptTurns(rows ?? []);
  return messages.map(message => { const turnId = turns.get(message.uuid); return turnId ? { ...message, turnId } : message; });
}

/** A sub-agent's rows carry their tool results as the live frames of its view do. */
async function childMessages(parentId: string, childId: string) {
  return withTranscriptExtras(parentId, await getSubagentMessages(parentId, childId), await readSubagentTranscript(parentId, childId));
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
  for (const id of await listSubagents(parentId)) children.push({ id, messages: await childMessages(parentId, id) });
  return children;
}
