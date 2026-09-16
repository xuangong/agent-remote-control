import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createGatewayRelay } from './gateway-relay.js';
import { createGatewayStaticPages } from './gateway-static.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
const server = createGatewayRelay({
  stateFile: join(process.env.AGENT_REMOTE_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'gateway-relay'), 'state.json'),
  origin: required('AGENT_REMOTE_RELAY_URL'), issuer: required('AGENT_REMOTE_ISSUER'),
  previewOrigin: process.env.AGENT_REMOTE_PREVIEW_URL,
  secret: required('AGENT_REMOTE_SIGNING_SECRET'),
  servePage: await createGatewayStaticPages(process.env.AGENT_REMOTE_WEB_DIST ?? fileURLToPath(new URL('../../dist', import.meta.url))),
});
const port = Number(process.env.AGENT_REMOTE_PORT ?? 5910);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('AGENT_REMOTE_PORT must be a valid port.');
const address = await server.listen(port, process.env.AGENT_REMOTE_BIND ?? '127.0.0.1');
console.log(`Authenticated Agent Remote controller: ${address.url}`);
if (process.env.AGENT_REMOTE_READY_FILE) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(resolve(process.env.AGENT_REMOTE_READY_FILE), JSON.stringify({ url: address.url, port: address.port }), { mode: 0o600 });
}
const close = async () => { await server.close(); process.exit(0); };
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
