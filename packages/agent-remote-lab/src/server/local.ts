import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { CodexAppServerProvider, spawnCodexAppServer } from '@borgee/agent-provider-codex';
import { createProtocolValidationServer } from '../server.js';
import { createCodexDirectory } from './codex-directory.js';
import { attachFixtureControls, createRecordedLabProvider } from './recorded.js';

export interface LocalServerOptions {
  origin: string;
  executable?: string;
  codexHome?: string;
  workspace?: string;
}

export function createLocalServer(options: LocalServerOptions) {
  const executable = options.executable ?? 'codex';
  const workspace = resolve(options.workspace ?? process.cwd());
  const env = options.codexHome ? { CODEX_HOME: resolve(options.codexHome) } : undefined;
  let checked: Promise<void> | undefined;
  async function checkExecutable(): Promise<void> {
    const { stdout } = await promisify(execFile)(executable, ['--version'], { timeout: 5000 });
    const version = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(stdout.trim());
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 148)) {
      throw new Error(`Codex 0.148.0 or newer is required; found ${stdout.trim()}. Set AGENT_REMOTE_CODEX_EXECUTABLE to a compatible CLI.`);
    }
  }
  const codex = new CodexAppServerProvider({
    requestTimeoutMs: 15000,
    async spawn(context) {
      checked ??= checkExecutable().catch((error) => { checked = undefined; throw error; });
      await checked;
      return spawnCodexAppServer({ executable, cwd: context.cwd ?? workspace, env });
    },
  });
  const recorded = createRecordedLabProvider();
  const server = createProtocolValidationServer({
    providers: [recorded.provider, codex], labOrigin: options.origin,
    directories: [createCodexDirectory(codex, workspace)],
  });
  attachFixtureControls(server, recorded.controller);
  return server;
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const origin = process.env.AGENT_REMOTE_ORIGIN ?? 'http://127.0.0.1:6175';
  const server = createLocalServer({
    origin, executable: process.env.AGENT_REMOTE_CODEX_EXECUTABLE,
    codexHome: process.env.AGENT_REMOTE_CODEX_HOME, workspace: process.env.AGENT_REMOTE_WORKSPACE,
  });
  const address = await server.http.listen(Number(process.env.AGENT_REMOTE_PORT ?? 5910), '127.0.0.1');
  console.log(`Agent Remote relay: ${address.url} (Codex, Recorded, and paired DSH Hosts)`);
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
}
