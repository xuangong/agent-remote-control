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
  if (provider === 'opencode') {
    if (executable) throw usage('OpenCode connects to an existing server; configure AGENT_HOST_OPENCODE_URL instead of --executable.');
    const { OpenCodeAgentProvider } = await import('./providers/opencode.js');
    return new OpenCodeAgentProvider({ serverUrl: process.env.AGENT_HOST_OPENCODE_URL, callbackConfigPath: process.env.AGENT_HOST_OPENCODE_CALLBACK_CONFIG, username: process.env.AGENT_HOST_OPENCODE_USERNAME, password: process.env.AGENT_HOST_OPENCODE_PASSWORD });
  }
  throw usage('Provider must be codex, claude, copilot or opencode; use --adapter for a custom provider.');
}
function usage(message: string) { return new DebuggerError(2, 'invalid_server_options', message, false); }
