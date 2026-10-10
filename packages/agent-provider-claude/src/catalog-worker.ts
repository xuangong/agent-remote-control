import { renameSession, getSessionInfo, getSessionMessages, listSessions, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeHistoryError, readClaudeHistoryPage } from './reference-history.js';

const [operation, sessionId, argument] = process.argv.slice(2);
try {
  const result = operation === 'history' && sessionId && argument ? await readHistory(sessionId, argument)
    : operation === 'rename' && sessionId && argument ? await renameSession(sessionId, argument) : operation === 'list' ? await listSessions() : operation === 'info' && sessionId ? await getSessionInfo(sessionId)
    : operation === 'messages' && sessionId ? await getSessionMessages(sessionId)
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
    return { page: await readClaudeHistoryPage({ info: getSessionInfo, messages: getSessionMessages }, id, JSON.parse(argument)) };
  } catch (error) {
    return { error: error instanceof ClaudeHistoryError ? error.message : 'Claude source history is unavailable.' };
  }
}

async function readChildren(parentId: string) {
  const children = [];
  for (const id of await listSubagents(parentId)) children.push({ id, messages: await getSubagentMessages(parentId, id) });
  return children;
}
