import { AgentOperationRejectedError, type AgentProviderDescriptor, type AgentSessionConfig, type AgentSessionExtensions } from '@orchardworks/agent-provider-sdk';

/** What a role chooses for a session the Controller creates for it. Omitted values keep the provider's defaults. */
export interface SessionCreation { cwd?: string | undefined; model?: string | undefined; reasoningEffort?: string | undefined }

/** The native configuration of a role session. Read-only access needs a provider that enforces it natively. */
export function roleSessionConfig(descriptor: AgentProviderDescriptor, creation: SessionCreation, extensions: AgentSessionExtensions): Omit<AgentSessionConfig, 'sessionId'> {
  if (extensions.access === 'read_only' && !descriptor.sessionAccess?.readOnly) {
    throw new AgentOperationRejectedError('operation_rejected', `${descriptor.displayName} cannot run read-only sessions.`);
  }
  return { ...(creation.cwd ? { cwd: creation.cwd } : {}), ...(creation.model ? { model: creation.model } : {}),
    ...(creation.reasoningEffort ? { reasoningEffort: creation.reasoningEffort } : {}), ...extensions };
}
