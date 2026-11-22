import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createGatewayRelay } from './gateway-relay.js';
import { createGatewayStaticPages } from './gateway-static.js';
import { hostedAuthFromEnv, pushFromEnvironment } from '@orchardworks/agent-relay-core';

const auth = hostedAuthFromEnv(process.env);
// Web Push reminders, with the same variables as the Worker: both halves of the VAPID key pair, or neither.
const push = pushFromEnvironment(process.env, auth.origin);
if (push.problem) console.error(`Configuration error: ${push.problem}`);
const stateDirectory = process.env.AGENT_REMOTE_STATE_DIR ?? join(homedir(), '.agent-remote-control', 'gateway-relay');
const server = createGatewayRelay({
  ...auth,
  stateFile: join(stateDirectory, 'state.json'),
  ...(process.env.AGENT_REMOTE_JOURNALS === '1' ? { journalFile: join(stateDirectory, 'journals.sqlite') } : {}),
  previewOrigin: process.env.AGENT_REMOTE_PREVIEW_URL,
  previewDomain: process.env.AGENT_REMOTE_PREVIEW_DOMAIN,
  ...(process.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS ? { authorityOutageGraceMs: Number(process.env.AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS) } : {}),
  ...(push.configuration ? { push: push.configuration } : {}), onPushProblem: problem => console.error(`Configuration error: ${problem}`),
  servePage: await createGatewayStaticPages(process.env.AGENT_REMOTE_WEB_DIST ?? fileURLToPath(new URL('../../agent-remote-lab/dist', import.meta.url)), { origin: auth.origin, previewDomain: process.env.AGENT_REMOTE_PREVIEW_DOMAIN }),
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
