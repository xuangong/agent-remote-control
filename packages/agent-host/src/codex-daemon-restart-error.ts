const messages = {
  unsupported_cli: 'Refreshing the Codex daemon and updater requires Codex CLI 0.156.0 or newer. Update Codex before restarting through the Controller. No lifecycle command was dispatched.',
  invalid_settings: 'Cannot read valid Codex daemon settings. Repair CODEX_HOME/app-server-daemon/settings.json before restarting. No lifecycle command was dispatched.',
} as const;

/** Only these Controller-owned preflight failures are safe to display through the website. */
export class CodexDaemonRestartRejected extends Error {
  constructor(readonly reason: keyof typeof messages) { super(messages[reason]); }
}

/** Native diagnostics may contain credentials; never forward partial matches or unknown stderr. */
export function readCodexDaemonRestartRejection(stderr: unknown): CodexDaemonRestartRejected | undefined {
  if (typeof stderr !== 'string') return;
  for (const reason of Object.keys(messages) as (keyof typeof messages)[]) {
    if (stderr.trim() === messages[reason]) return new CodexDaemonRestartRejected(reason);
  }
}
