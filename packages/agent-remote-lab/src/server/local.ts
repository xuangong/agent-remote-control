import { createProtocolValidationServer } from '../server.js';
import { attachFixtureControls, createRecordedLabProvider } from './recorded.js';

export interface LocalServerOptions {
  origin: string;
}

export function createLocalServer(options: LocalServerOptions) {
  const recorded = createRecordedLabProvider();
  const server = createProtocolValidationServer({
    providers: [recorded.provider], labOrigin: options.origin,
  });
  attachFixtureControls(server, recorded.controller);
  return server;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const origin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
  const server = createLocalServer({
    origin,
  });
  const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT ?? 5910), process.env.AGENT_REMOTE_BIND ?? '127.0.0.1');
  console.log(`Agent Remote relay: ${address.url} (Recorded fixture and paired Agent Hosts)`);
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}
