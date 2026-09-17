import type { CodexAppServerTransport } from './app-server-transport.js';

export interface CodexInitialization {
  clientInfo: { name: string; version: string; title?: string };
  capabilities?: Record<string, unknown>;
}

export async function initializeCodexTransport(transport: CodexAppServerTransport, initialization: CodexInitialization): Promise<void> {
  await transport.request('initialize', initialization);
  transport.notify('initialized', {});
}
