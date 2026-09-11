import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A stdio MCP peer that asks once and records the native client's exact response. */
export async function writeMcpFormServer(cwd: string, schema: Record<string, unknown>) {
  const resultPath = join(cwd, 'elicitation-result.json');
  const serverPath = join(cwd, 'form-server.mjs');
  await writeFile(serverPath, `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let toolRequest;
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } } });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools: [{ name: 'collect_preferences', description: 'Collect preferences from the user.', inputSchema: { type: 'object', properties: {} } }] } });
  else if (message.method === 'tools/call') {
    toolRequest = message.id;
    send({ id: 'native-form-request', method: 'elicitation/create', params: { mode: 'form', message: 'Native MCP preferences', requestedSchema: ${JSON.stringify(schema)} } });
  } else if (message.id === 'native-form-request') {
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(message));
    send({ id: toolRequest, result: { content: [{ type: 'text', text: 'User form response: ' + message.result.action }] } });
  } else if (message.method === 'ping') send({ id: message.id, result: {} });
});
`);
  return { resultPath, serverPath };
}
