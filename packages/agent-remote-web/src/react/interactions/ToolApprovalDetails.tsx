import type { AgentInteractionRequest } from '@orchardworks/agent-remote-protocol';

import { ToolCallDetails } from '../items/ToolCallItem.js';

export function ToolApprovalDetails({ request }: {
  readonly request: Extract<AgentInteractionRequest, { kind: 'tool_approval' }>;
}) {
  const { detail } = request;
  return <div className="agent-approval-details">
    <p className="agent-approval-reason">{request.summary}</p>
    {detail.type === 'shell' ? <div className="agent-approval-command">
      <span className="agent-approval-label">Command</span>
      <pre tabIndex={0} aria-label="Command"><code>{detail.command}</code></pre>
    </div> : <ToolCallDetails detail={detail} />}
    {(detail.type === 'shell' && detail.cwd) || request.context?.length ? <dl className="agent-approval-context">
      {detail.type === 'shell' && detail.cwd ? <div className="agent-approval-directory"><dt>Working directory</dt><dd><code>{detail.cwd}</code></dd></div> : null}
      {request.context?.map(({ label, value }, index) => <div key={index}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl> : null}
  </div>;
}
