import { getSessionInfo, getSessionMessages, listSessions, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';

const [operation, sessionId, childId] = process.argv.slice(2);
try {
  const result = operation === 'list' ? await listSessions() : operation === 'info' && sessionId ? await getSessionInfo(sessionId)
    : operation === 'messages' && sessionId ? await getSessionMessages(sessionId)
    : operation === 'child-messages' && sessionId && childId ? await getSubagentMessages(sessionId, childId)
    : operation === 'children' && sessionId ? await readChildren(sessionId)
    : (() => { throw new Error('Unknown catalog operation.'); })();
  process.stdout.write(JSON.stringify(result ?? null));
} catch {
  process.stderr.write('Claude native catalog could not be read.\n');
  process.exitCode = 1;
}

async function readChildren(parentId: string) {
  const children = [];
  for (const id of await listSubagents(parentId)) children.push({ id, messages: await getSubagentMessages(parentId, id) });
  return children;
}
