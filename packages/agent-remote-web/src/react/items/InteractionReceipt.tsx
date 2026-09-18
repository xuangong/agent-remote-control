import { TimelineTitle } from '../TimelineTitle.js';
import type { AgentInteractionRequest, AgentInteractionResponse } from '@agent-remote-controller/agent-remote-protocol';

export function InteractionReceipt({ request, response }: { request: AgentInteractionRequest; response: AgentInteractionResponse }) {
  if (request.kind === 'form' && response.kind === 'form') {
    return <article className="agent-item agent-interaction-completed">
      <header><TimelineTitle className="agent-item-kicker">FORM</TimelineTitle><span className="agent-state-label">{response.action === 'submit' ? 'Submitted' : response.action === 'cancel' ? 'Canceled' : 'Declined'}</span></header>
      <h3>{request.title}</h3>
      {response.action === 'submit' ? <dl className="agent-form-receipt">{request.fields.map((field) => {
        const value = response.values[field.fieldId];
        const hidden = field.sensitive || response.redactedFields?.includes(field.fieldId);
        const shown = Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? value ? 'Yes' : 'No' : String(value ?? 'Not provided');
        return <div key={field.fieldId}><dt>{field.label}</dt><dd>{hidden ? 'Hidden answer' : shown}</dd></div>;
      })}</dl> : null}
    </article>;
  }
  if (request.kind === 'permission_approval' && response.kind === 'permission_approval') {
    return <article className="agent-item agent-interaction-completed"><header><TimelineTitle className="agent-item-kicker">PERMISSIONS</TimelineTitle><span className="agent-state-label">{response.decision === 'allow' ? `Allowed · ${response.scope}` : 'Denied'}</span></header><p>{request.summary}</p><ul className="agent-permission-list">{request.permissions.map((permission, index) => <li key={index}><strong>{permission.access} · {permission.resource}</strong><code>{permission.target}</code></li>)}</ul></article>;
  }
  if (request.kind === 'external_action' && response.kind === 'external_action') {
    return <article className="agent-item agent-interaction-completed"><header><TimelineTitle className="agent-item-kicker">EXTERNAL ACTION</TimelineTitle><span className="agent-state-label">{response.action === 'completed' ? 'Completed' : response.action === 'cancel' ? 'Canceled' : 'Declined'}</span></header><p>{request.title}</p></article>;
  }
  return <article className="agent-item agent-interaction-completed" role="status">The recorded interaction response does not match its request.</article>;
}
