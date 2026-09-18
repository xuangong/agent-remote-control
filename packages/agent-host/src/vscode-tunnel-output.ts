import { vscodeTunnelLink } from '@agent-remote-controller/agent-remote-protocol';

export type TunnelOutput = { type: 'authorization'; url: string; code: string }
  | { type: 'connected'; name: string; attached?: boolean } | { type: 'tokenError' };

export function parseTunnelOutput(raw: string): TunnelOutput | undefined {
  const line = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').trim();
  const marker = '__VSCODE_CLI_STATUS__';
  if (line.startsWith(marker)) {
    try {
      const value = JSON.parse(line.slice(marker.length));
      if (value.type === 'tokenError') return { type: 'tokenError' };
      if (value.type === 'connected' && typeof value.tunnelName === 'string' && vscodeTunnelLink(value.tunnelName)) {
        return { type: 'connected', name: value.tunnelName, ...(typeof value.isAttached === 'boolean' ? { attached: value.isAttached } : {}) };
      }
    } catch { /* Partial or unknown CLI output is not state. */ }
  }
  const auth = /please log into (https:\/\/[^\s]+) and use code ([A-Z0-9-]{6,24})(?:\s|$)/i.exec(line);
  if (auth && ['https://github.com/login/device', 'https://microsoft.com/devicelogin', 'https://www.microsoft.com/devicelogin'].includes(auth[1]!)) {
    return { type: 'authorization', url: auth[1]!, code: auth[2]! };
  }
  const name = /(?:➜\s*)?Tunnel:\s+([a-zA-Z0-9-]+)\s*$/.exec(line)?.[1]
    ?? /https:\/\/vscode\.dev\/tunnel\/([a-zA-Z0-9-]+)(?:\/|\s|$)/.exec(line)?.[1];
  return name && vscodeTunnelLink(name) ? { type: 'connected', name } : undefined;
}

/** Bounds each stream independently, including unterminated diagnostic lines. */
export function tunnelOutputLines(onLine: (line: string) => void) {
  let pending = ''; let dropping = false;
  return (chunk: string) => {
    for (const character of chunk) {
      if (character === '\n' || character === '\r') {
        if (!dropping && pending) onLine(pending);
        pending = ''; dropping = false;
      } else if (!dropping) {
        pending += character;
        if (pending.length > 8192) { pending = ''; dropping = true; }
      }
    }
  };
}
