import type { AgentInteractionRequest, AgentInteractionResponse } from '@borgee/agent-provider-sdk';
import { isRecord, readString } from './native.js';
import { mapCodexPermissions } from './permissions.js';

type ToolRequest = Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
export function mapCodexToolApproval(nativeKind: 'command' | 'file', params: Record<string, unknown>, requestId: string): { request: ToolRequest; respond(response: AgentInteractionResponse): unknown } {
  const itemId = readString(params.itemId);
  if (!itemId) throw new Error('Codex tool approval request has no item id');
  const command = readString(params.command);
  const cwd = readString(params.cwd);
  const reason = readString(params.reason);
  const decisions: unknown[] = params.availableDecisions == null ? ['accept', 'acceptForSession', 'decline', 'cancel'] : Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  if (params.availableDecisions == null && nativeKind === 'command') {
    if (params.proposedExecpolicyAmendment != null) decisions.push({ acceptWithExecpolicyAmendment: { execpolicy_amendment: params.proposedExecpolicyAmendment } });
    if (Array.isArray(params.proposedNetworkPolicyAmendments)) for (const amendment of params.proposedNetworkPolicyAmendments) decisions.push({ applyNetworkPolicyAmendment: { network_policy_amendment: amendment } });
  }
  const allowedDecisions: ToolRequest['allowedDecisions'] = [];
  const allowScopes: ToolRequest['allowScopes'] = [];
  const policies: NonNullable<ToolRequest['policies']> = [];
  const nativePolicies = new Map<string, unknown>();
  for (const decision of decisions) {
    if (decision === 'accept' || decision === 'acceptForSession') {
      allowedDecisions.push('allow');
      allowScopes.push(decision === 'accept' ? 'once' : 'session');
    } else if (decision === 'decline') allowedDecisions.push('deny');
    else if (decision === 'cancel') allowedDecisions.push('cancel');
    else {
      const description = policyDescription(decision);
      if (!description || nativeKind !== 'command') throw new Error('Unsupported native approval decision');
      const policyId = `policy:${policies.length}`;
      policies.push({ policyId, description });
      nativePolicies.set(policyId, structuredClone(decision));
      allowedDecisions.push('allow');
      allowScopes.push('policy');
    }
  }
  if (!allowedDecisions.length) throw new Error('No supported approval decisions');
  const context: NonNullable<ToolRequest['context']> = [];
  if (isRecord(params.networkApprovalContext)) {
    const { host, protocol } = params.networkApprovalContext;
    if (typeof host !== 'string' || typeof protocol !== 'string') throw new Error('Invalid network context');
    context.push({ label: 'Network', value: `${protocol}://${host}` });
  }
  if (params.additionalPermissions != null) for (const p of mapCodexPermissions(params.additionalPermissions).permissions) context.push({ label: `${p.resource} ${p.access}`, value: p.target });
  if (readString(params.grantRoot)) context.push({ label: 'Session write root', value: params.grantRoot as string });
  if (readString(params.environmentId)) context.push({ label: 'Environment', value: params.environmentId as string });
  const request: ToolRequest = {
    kind: 'tool_approval', requestId, toolCallId: itemId, toolName: nativeKind === 'command' ? 'command' : 'file_change',
    summary: reason || (nativeKind === 'command' ? `Run ${command || 'a command'}` : 'Apply file changes'),
    detail: nativeKind === 'command' && command ? { type: 'shell', command, ...(cwd ? { cwd } : {}) } : { type: 'other', description: nativeKind === 'command' ? reason || 'Run a command' : 'Apply Codex file changes' },
    allowedDecisions: [...new Set(allowedDecisions)], allowScopes: [...new Set(allowScopes)],
    ...(policies.length ? { policies } : {}), ...(context.length ? { context } : {}),
  };
  return { request, respond(response) {
    if (response.kind !== 'tool_approval') throw new Error('Invalid tool approval response');
    if (response.decision === 'deny') return { decision: 'decline' };
    if (response.decision !== 'allow') return { decision: 'cancel' };
    if (response.scope === 'policy') {
      if (!nativePolicies.has(response.policyId)) throw new Error('Unknown native policy');
      return { decision: nativePolicies.get(response.policyId) };
    }
    return { decision: response.scope === 'session' ? 'acceptForSession' : 'accept' };
  } };
}

function policyDescription(value: unknown): string | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 1) return undefined;
  if (isRecord(value.acceptWithExecpolicyAmendment)) {
    const parts = value.acceptWithExecpolicyAmendment.execpolicy_amendment;
    if (Object.keys(value.acceptWithExecpolicyAmendment).length !== 1 || !Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== 'string')) return undefined;
    return `Allow command prefix ${JSON.stringify(parts)} for future commands`;
  }
  if (isRecord(value.applyNetworkPolicyAmendment)) {
    const amendment = value.applyNetworkPolicyAmendment.network_policy_amendment;
    if (Object.keys(value.applyNetworkPolicyAmendment).length !== 1 || !isRecord(amendment) || Object.keys(amendment).some((key) => !['host', 'action'].includes(key)) || !readString(amendment.host) || !['allow', 'deny'].includes(String(amendment.action))) return undefined;
    return `${amendment.action === 'allow' ? 'Allow' : 'Deny'} network host ${amendment.host} for future requests`;
  }
  return undefined;
}
