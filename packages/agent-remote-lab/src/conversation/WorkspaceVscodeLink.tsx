// A conversation's link to its workspace in VS Code, through the Host's tunnel when it runs.
import { vscodeWorkspaceLink } from '@orchardworks/agent-remote-protocol';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { useVscodeTunnel } from '../kernel/vscode-tunnel.js';

export function WorkspaceVscodeLink({ workspace }: { workspace?: string }) {
  const t = useTranslate();
  const controller = useVscodeTunnel();
  if (!controller || !workspace) return null;
  const { state, host, error } = controller;
  const href = host.online && !error && state?.processAlive && state.status === 'connected' && state.tunnelName
    ? vscodeWorkspaceLink(state.tunnelName, workspace) : undefined;
  const unavailableReason = !host.online ? t('hosts.vscode.offline')
    : state?.status === 'unavailable' ? state.message ?? t('hosts.vscode.unsupported')
      : t('hosts.vscode.startHint');
  return href ? <a className="lab-vscode-workspace" data-vscode-workspace href={href} target="_blank" rel="noreferrer" title={t('hosts.vscode.openWorkspace', { workspace })}>VS Code ↗</a>
    : <span className="lab-vscode-workspace lab-vscode-unavailable" title={unavailableReason} aria-label={t('hosts.vscode.workspaceUnavailable', { reason: unavailableReason })}>VS Code</span>;
}
