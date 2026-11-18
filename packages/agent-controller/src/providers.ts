/**
 * Providers: the one file of the Controller that names the concrete provider packages.
 *
 * Contract. Everything the Controller takes from a provider package comes through this file: the adapters it constructs, the helpers its commands and
 * supervisors call (executable resolution, versions, the Windows Codex daemon), and the provider types its directories are written against. The Claude and
 * OpenCode packages load on first use, as before, so a Controller that never opens one does not pay for it. A provider the Controller does not know is not
 * reachable from the session core; it gets in through a registration.
 */
export { CodexAppServerProvider, readWindowsCodexDaemon, requestWindowsCodexDaemon, serveWindowsCodexDaemon, windowsCodexDaemonDirectory, windowsCodexSharedEndpoint } from '@orchardworks/agent-provider-codex';
export type { CodexAppServerProviderOptions, CodexSessionSummary } from '@orchardworks/agent-provider-codex';
export { CopilotAgentProvider, resolveCopilotExecutable } from '@orchardworks/agent-provider-copilot';
export type { CopilotAgentProviderOptions } from '@orchardworks/agent-provider-copilot';
export { openCodeVersionIssue, parseOpenCodeCliVersion } from '@orchardworks/agent-provider-opencode';
export type { OpenCodeAgentProvider, OpenCodeAgentProviderOptions, OpenCodeSessionSummary } from '@orchardworks/agent-provider-opencode';

/** The Claude provider package, loaded when a Claude registration is made. */
export const loadClaudeProvider = () => import('@orchardworks/agent-provider-claude');
/** The OpenCode provider package, loaded when an OpenCode registration or its callbacks are set up. */
export const loadOpenCodeProvider = () => import('@orchardworks/agent-provider-opencode');
