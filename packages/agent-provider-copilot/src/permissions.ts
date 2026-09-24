import type {CopilotSession, SessionEvent} from '@github/copilot-sdk';
import type {AgentInteractionRequest} from '@orchardworks/agent-provider-sdk';
import {detail, record} from './native.js';

type PermissionEvent = Extract<SessionEvent, {type: 'permission.requested'}>;
type Decision = Parameters<CopilotSession['rpc']['permissions']['handlePendingPermissionRequest']>[0]['result'];

/** Preserve native approval scopes; a path grant and a tool grant are separate checks. */
export function sessionApproval(event: PermissionEvent): Decision | undefined {
 const prompt = record(event.data.promptRequest);
 if (prompt.managedApprovalRequired === true) return undefined;
 if (prompt.kind === 'read') return {kind: 'approve-for-session', approval: {kind: 'read'}};
 if (prompt.kind === 'path') return {kind: 'approve-for-session'};
 if (prompt.canOfferSessionApproval !== true) return undefined;
 if (prompt.kind === 'commands' && Array.isArray(prompt.commandIdentifiers) && prompt.commandIdentifiers.length && prompt.commandIdentifiers.every(v => typeof v === 'string'))
  return {kind: 'approve-for-session', approval: {kind: 'commands', commandIdentifiers: prompt.commandIdentifiers}};
 if (prompt.kind === 'write') return {kind: 'approve-for-session', approval: {kind: 'write'}};
}

export function permissionRequest(event: PermissionEvent): Extract<AgentInteractionRequest, {kind: 'tool_approval'}> {
 const raw = record(event.data.permissionRequest);
 const prompt = record(event.data.promptRequest);
 const toolCallId = prompt.toolCallId ?? raw.toolCallId;
 const pathAccess = prompt.kind === 'path';
 const intent = prompt.intention ?? raw.intention;
 const summary = pathAccess ? `Allow ${prompt.accessKind === 'write' ? 'write' : 'read'} access to this path.`
  : typeof intent === 'string' && intent.trim() ? intent : `Allow this ${event.data.permissionRequest.kind} operation.`;
 const context: {label: string; value: string}[] = [];
 const grant = sessionApproval(event);
 if (pathAccess) context.push({label: 'Permission', value: 'Path access; tool approval may be requested separately.'});
 if (prompt.kind === 'read' && grant) context.push({label: 'Session approval', value: 'Allows read tools for the rest of this session; path access is checked separately.'});
 for (const [key, label] of [['warning', 'Warning'], ['requestSandboxBypassReason', 'Sandbox bypass reason']] as const) {
  const value = prompt[key] ?? raw[key]; if (typeof value === 'string' && value) context.push({label, value});
 }
 const fields = {...raw, ...prompt};
 for (const [key, label] of [
  ['url', 'URL'], ['redirectedFrom', 'Redirected from'], ['serverName', 'MCP server'], ['toolName', 'Tool'],
  ['toolTitle', 'Tool title'], ['args', 'Arguments'], ['diff', 'Proposed changes'], ['newFileContents', 'New file contents'],
  ['extensionName', 'Extension'], ['capabilities', 'Capabilities'], ['fact', 'Fact'], ['subject', 'Subject'],
  ['operation', 'Operation'], ['name', 'Name'], ['phases', 'Phases'],
 ] as const) {
  const value = fields[key];
  if (value !== undefined && value !== '') context.push({label, value: typeof value === 'string' ? value : JSON.stringify(value)});
 }
 if (pathAccess && Array.isArray(prompt.paths) && prompt.paths.length > 1) context.push({label: 'Paths', value: prompt.paths.filter(v => typeof v === 'string').join('\n')});
 if (grant && prompt.kind === 'commands') context.push({label: 'Session approval', value: `Allows these command patterns: ${(prompt.commandIdentifiers as string[]).join(', ')}`});
 if (grant && prompt.kind === 'write') context.push({label: 'Session approval', value: 'Allows write tools for the rest of this session; path access is checked separately.'});
 if (prompt.requestSandboxBypass === true || raw.requestSandboxBypass === true) context.push({label: 'Network access', value: 'Requests bypass of the sandbox network policy.'});
 const mappedDetail = detail(event.data.permissionRequest.kind, {...raw, ...prompt});
 return {kind: 'tool_approval', requestId: event.data.requestId, toolCallId: typeof toolCallId === 'string' ? toolCallId : event.data.requestId,
  toolName: pathAccess ? 'Path access' : event.data.permissionRequest.kind, summary, detail: mappedDetail,
  allowedDecisions: ['allow', 'deny'], allowScopes: grant ? ['once', 'session'] : ['once'], ...(context.length ? {context} : {})};
}
