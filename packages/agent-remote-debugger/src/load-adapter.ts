import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DebuggerAdapter } from './server.js';
import { DebuggerError } from './errors.js';

export async function loadAdapter(provider: string | undefined, module: string | undefined, executable: string | undefined): Promise<DebuggerAdapter> {
  if (module) {
    let loaded: { createAdapter?: () => Promise<DebuggerAdapter> | DebuggerAdapter };
    try { loaded = await import(pathToFileURL(resolve(module)).href); }
    catch (error) { throw usage(`Cannot load Adapter module: ${error instanceof Error ? error.message : String(error)}`); }
    if (typeof loaded.createAdapter !== 'function') throw usage('Adapter module must export createAdapter().');
    const adapter = await loaded.createAdapter();
    if (!adapter?.descriptor?.providerId || typeof adapter.createSession !== 'function' || typeof adapter.resumeSession !== 'function') throw usage('createAdapter() must return an AgentProviderAdapter.');
    return adapter;
  }
  if (provider === 'codex') { const { CodexAppServerProvider } = await import('@orchardworks/agent-provider-codex'); return new CodexAppServerProvider({ executable, connectionMode: 'private' }); }
  if (provider === 'claude') { const { ClaudeAgentProvider } = await import('./providers/claude.js'); return new ClaudeAgentProvider({ executable }); }
  if (provider === 'copilot') { const { CopilotAgentProvider } = await import('./providers/copilot.js'); return new CopilotAgentProvider({ executable }); }
  throw usage('Provider must be codex, claude or copilot; use --adapter for a custom provider.');
}
function usage(message: string) { return new DebuggerError(2, 'invalid_server_options', message, false); }
