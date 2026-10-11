import {
  AGENT_NATIVE_EVIDENCE_REASONS,
  AgentOperationRejectedError,
  type AgentProviderNativeEvidence,
  type AgentSessionNativeEvidence,
} from '@orchardworks/agent-provider-sdk';

/** Stock 2.x cannot prove historical settings, so handoff stops before any native request. */
const unavailable = Object.freeze({
  status: 'unavailable' as const,
  code: 'native_evidence_unsupported' as const,
  reason: 'OpenCode 2.x does not expose the historical settings evidence required for session handoff.',
});
function reject(): never { throw new AgentOperationRejectedError(unavailable.code, unavailable.reason); }

export const openCodeProviderNativeEvidence: AgentProviderNativeEvidence = Object.freeze({
  availability: () => unavailable,
  createEmpty: async () => reject(),
});

export const openCodeSessionNativeEvidence: AgentSessionNativeEvidence = Object.freeze({
  availability: () => unavailable,
  inspectReadiness: async () => reject(),
  prepareInput: async () => reject(),
  dispatchInput: async () => reject(),
  inspectInput: async () => ({ status: 'unknown' as const, code: unavailable.code, reason: AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_unsupported }),
  captureValidity: () => reject(),
  isCurrent: () => false,
});
