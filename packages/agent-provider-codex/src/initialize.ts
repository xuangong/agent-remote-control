import type { CodexAppServerTransport } from './app-server-transport.js';

export async function initializeCodexTransport(transport: CodexAppServerTransport): Promise<void> {
  await transport.request('initialize', {
    clientInfo: { name: 'codex_app_server_daemon', title: 'Agent Remote Control', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
  });
  transport.notify('initialized', {});
}
