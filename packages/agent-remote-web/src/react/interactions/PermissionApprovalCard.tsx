import type { AgentInteractionRequest, AgentInteractionResponse } from '@orchardworks/agent-remote-protocol';

interface Props {
  request: Extract<AgentInteractionRequest, { kind: 'permission_approval' }>;
  onResponse: (response: Extract<AgentInteractionResponse, { kind: 'permission_approval' }>) => Promise<void>;
  pending: boolean;
  failure?: string;
}

export function PermissionApprovalCard({ request, onResponse, pending, failure }: Props) {
  return <section className="agent-interaction agent-permission" aria-busy={pending}>
    <header><span className="agent-item-kicker">PERMISSION REQUEST</span><h3>Review requested access</h3></header>
    <p>{request.summary}</p>
    <ul className="agent-permission-list">{request.permissions.map((permission, index) => <li key={index}><strong>{permission.access} · {permission.resource}</strong><code>{permission.target}</code></li>)}</ul>
    <div className="agent-interaction-actions">
      {request.allowScopes.map((scope) => <button key={scope} type="button" disabled={pending} data-scope={scope} onClick={() => void onResponse({ kind: 'permission_approval', decision: 'allow', scope })}>Allow for {scope}</button>)}
      <button type="button" disabled={pending} onClick={() => void onResponse({ kind: 'permission_approval', decision: 'deny' })}>Deny</button>
    </div>
    {failure ? <p className="agent-form-error" role="alert">{failure}</p> : null}
  </section>;
}
