/**
 * The extension the adapter loads into every pi process it starts (`pi -e <file>`). pi has no permission system and no MCP, so the
 * adapter reaches its own policy and the Host's tools through pi's extension API, over pi's extension UI sub-protocol (docs/rpc.md):
 * an extension that calls `ctx.ui.input(title, placeholder)` makes pi print an `extension_ui_request` and wait for the answer on
 * stdin. The title names this bridge, the placeholder carries one JSON request, and the answer is one JSON string.
 *
 * - approval: before a tool runs, `{kind: 'approval', toolCallId, toolName, input}`; the answer `{allow: true}` or `{allow: false, reason}`.
 * - tools: at the start of every run, `{kind: 'tools'}`; the answer `{tools: [{name, description, inputSchema}]}` is what the session has now, so
 *   a session given tools after it started offers them from its next run, and one that lost them stops running them.
 * - tool: a Host tool the session was given runs in the adapter, `{kind: 'tool', name, toolCallId, arguments}`; the answer `{ok: true, text}`
 *   or `{ok: false, error}`.
 *
 * The extension is plain JavaScript so pi loads it without a build; it ships inside this package as the string below, and the adapter writes
 * it, with the session's tool declarations, to a private temporary directory it removes with the session. Nothing is written to pi's profile.
 */
export const BRIDGE_TITLE = 'arc.v1';
export const BRIDGE_CONFIG_ENV = 'ARC_PI_BRIDGE_CONFIG';

/** A Host tool as the extension registers it. */
export interface BridgeTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface BridgeConfig { tools: BridgeTool[] }

export type BridgeRequest =
  | { kind: 'approval'; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'tool'; name: string; toolCallId: string; arguments: unknown }
  | { kind: 'tools' };

export const BRIDGE_EXTENSION_SOURCE = `import { readFileSync } from 'node:fs';

const TITLE = ${JSON.stringify(BRIDGE_TITLE)};

export default function (pi) {
  const config = JSON.parse(readFileSync(process.env.${BRIDGE_CONFIG_ENV}, 'utf8'));
  const own = new Set();
  const ask = (ctx, request, signal) => ctx.ui.input(TITLE, JSON.stringify(request), { signal });

  function offer(tool) {
    if (own.has(tool.name)) return;
    own.add(tool.name);
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      promptSnippet: tool.description.split('. ')[0],
      parameters: tool.inputSchema,
      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        const answer = await ask(ctx, { kind: 'tool', name: tool.name, toolCallId, arguments: params }, signal);
        if (answer === undefined) throw new Error('The tool call was canceled.');
        let result;
        try { result = JSON.parse(answer); } catch { throw new Error('The tool answer was unreadable.'); }
        if (!result || result.ok !== true) throw new Error(result && typeof result.error === 'string' ? result.error : 'The tool failed.');
        return { content: [{ type: 'text', text: typeof result.text === 'string' ? result.text : '' }], details: {} };
      },
    });
  }
  for (const tool of config.tools) offer(tool);

  // The tools the session has now, asked at the start of each run: tools given after pi started are registered before the model is called.
  pi.on('before_agent_start', async (_event, ctx) => {
    const answer = await ask(ctx, { kind: 'tools' }, ctx.signal);
    if (answer === undefined) return undefined;
    let current;
    try { current = JSON.parse(answer); } catch { return undefined; }
    for (const tool of current && Array.isArray(current.tools) ? current.tools : []) offer(tool);
    return undefined;
  });

  pi.on('tool_call', async (event, ctx) => {
    // The Host's own tools run without a prompt, as they do in every other provider.
    if (own.has(event.toolName)) return undefined;
    const answer = await ask(ctx, { kind: 'approval', toolCallId: event.toolCallId, toolName: event.toolName, input: event.input }, ctx.signal);
    if (answer === undefined) return { block: true, reason: 'The approval was canceled.' };
    let decision;
    try { decision = JSON.parse(answer); } catch { return { block: true, reason: 'The approval answer was unreadable.' }; }
    if (decision && decision.allow === true) return undefined;
    return { block: true, reason: decision && typeof decision.reason === 'string' ? decision.reason : 'The user denied this tool call.' };
  });
}
`;

/** The bridge request an extension UI request carries, or undefined when the request is not the bridge's (a dialog of another extension). */
export function parseBridgeRequest(ui: Record<string, unknown>): BridgeRequest | undefined {
  if (ui.method !== 'input' || ui.title !== BRIDGE_TITLE || typeof ui.placeholder !== 'string') return undefined;
  let value: unknown;
  try { value = JSON.parse(ui.placeholder); } catch { return undefined; }
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Record<string, unknown>;
  if (request.kind === 'approval' && typeof request.toolCallId === 'string' && typeof request.toolName === 'string') return { kind: 'approval', toolCallId: request.toolCallId, toolName: request.toolName, input: request.input };
  if (request.kind === 'tools') return { kind: 'tools' };
  if (request.kind === 'tool' && typeof request.name === 'string' && typeof request.toolCallId === 'string') return { kind: 'tool', name: request.name, toolCallId: request.toolCallId, arguments: request.arguments };
  return undefined;
}
