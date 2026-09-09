import readline from 'node:readline';

import { createFakeChildProcess, type FakeChildProcess } from './fake-child.js';

export interface ScriptedAppServer {
  child: FakeChildProcess;
  requests: Array<{ id: number; method: string; params: unknown }>;
}

export function createScriptedAppServer(
  handlers: Record<string, (params: unknown) => unknown> = {},
): ScriptedAppServer {
  const child = createFakeChildProcess();
  const requests: ScriptedAppServer['requests'] = [];
  const lines = readline.createInterface({ input: child.stdin });
  lines.on('line', (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
    if (typeof message.id !== 'number' || !message.method) return;
    requests.push(message as ScriptedAppServer['requests'][number]);
    try {
      const result = handlers[message.method]?.(message.params) ?? {};
      child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    } catch (error) {
      child.stdout.write(`${JSON.stringify({
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })}\n`);
    }
  });
  return { child, requests };
}
