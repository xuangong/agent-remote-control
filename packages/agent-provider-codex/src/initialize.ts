import { initializeCodexTransport as initializeNativeTransport, type CodexInitialization } from '@agent-remote-controller/codex-daemon-client';
import type { CodexAppServerTransport } from './app-server-transport.js';

export const providerInitialization: CodexInitialization = {
  clientInfo: { name: 'codex_app_server_daemon', title: 'Agent Remote Control', version: '0.1.0' },
  capabilities: { experimentalApi: true, requestAttestation: false, mcpServerOpenaiFormElicitation: true },
};

export async function initializeCodexTransport(transport: CodexAppServerTransport): Promise<void> {
  await initializeNativeTransport(transport, providerInitialization);
}
