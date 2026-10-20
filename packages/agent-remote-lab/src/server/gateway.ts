import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createGatewayRelay } from './gateway-relay.js';
import { createGatewayStaticPages } from './gateway-static.js';
import { hostedAuthFromEnv } from '@orchardworks/agent-remote-hosted';

const auth = hostedAuthFromEnv(process.env);
const server = createGatewayRelay({
  ...auth,
  stateFile: join(process.env.AGENT_REMOTE_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'gateway-relay'), 'state.json'),
  previewOrigin: process.env.AGENT_REMOTE_PREVIEW_URL,
  previewDomain: process.env.AGENT_REMOTE_PREVIEW_DOMAIN,
  ...(process.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS ? { authorityOutageGraceMs: Number(process.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS) } : {}),
  servePage: await createGatewayStaticPages(process.env.AGENT_REMOTE_WEB_DIST ?? fileURLToPath(new URL('../../dist', import.meta.url)), { origin: auth.origin, previewDomain: process.env.AGENT_REMOTE_PREVIEW_DOMAIN }),
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
