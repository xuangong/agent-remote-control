import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import type { SessionCaller, SessionCallResult } from './session-routes.js';

/**
 * Role commands: what the role a session holds lets it do (a Team member, a support coordinator or supporter, a TPM, a
 * worker that calls for support), run from that session's shell. Each command is one of the role's tools, run by the
 * same handler with the same checks; only the transport differs.
 */
export const commandName = (tool: string) => tool.replaceAll('_', '-');
const camel = (option: string) => option.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

type Schema = { type?: string | string[]; items?: Schema; properties?: Record<string, Schema>; anyOf?: Schema[] };

/** Turns `--name value` options into a tool's input, by the types its schema gives; arrays take the option repeatedly. */
export function roleInput(schema: Schema, options: ReadonlyArray<readonly [string, string]>): Record<string, unknown> {
  const properties = schema.properties ?? {}, input: Record<string, unknown> = {};
  for (const [option, value] of options) {
    const name = Object.hasOwn(properties, option) ? option : camel(option);
    const property = properties[name];
    if (!property) throw new RoleCommandError('invalid_request', `Unknown option --${option}. Options: ${Object.keys(properties).map(key => `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`).join(', ') || 'none'}.`);
    if (property.type === 'array') { const list = (input[name] ??= []) as unknown[]; list.push(scalar(property.items ?? {}, value, option)); }
    else if (Object.hasOwn(input, name)) throw new RoleCommandError('invalid_request', `--${option} is given twice.`);
    else input[name] = scalar(property, value, option);
  }
  return input;
}
function scalar(schema: Schema, value: string, option: string): unknown {
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'string') return value;
  if (type === 'integer' || type === 'number') {
    const number = Number(value);
    if (!value.trim() || !Number.isFinite(number)) throw new RoleCommandError('invalid_request', `--${option} needs a number.`);
    return number;
  }
  if (type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new RoleCommandError('invalid_request', `--${option} is true or false.`);
    return value === 'true';
  }
  try { return JSON.parse(value); } catch { throw new RoleCommandError('invalid_request', `--${option} needs JSON.`); }
}

export class RoleCommandError extends Error { constructor(readonly code: string, message: string) { super(message); } }

export async function handleRoleRequest(input: unknown, caller: SessionCaller, tools: (caller: Extract<SessionCaller, { kind: 'session' }>) => Promise<readonly AgentSessionTool[]>): Promise<SessionCallResult> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RoleCommandError('invalid_request', 'The role command is invalid.');
    if (caller.kind !== 'session') throw new RoleCommandError('invalid_request', 'Role commands run in the shell of the session that holds the role.');
    const request = input as Record<string, unknown>, available = await tools(caller);
    if (request.command === 'list') {
      return { result: { commands: available.map(tool => ({ command: commandName(tool.name), description: tool.description, input: tool.inputSchema })) } };
    }
    if (request.command !== 'run' || typeof request.name !== 'string') throw new RoleCommandError('invalid_request', 'Use role list, or role <command>.');
    const tool = available.find(item => commandName(item.name) === request.name || item.name === request.name);
    if (!tool) throw new RoleCommandError('role_command_unavailable', available.length
      ? `This session's role has no command ${request.name}. Run agent-remote-controller role list.`
      : 'This session holds no role with commands.');
    const options = request.options === undefined ? [] : request.options;
    if (!Array.isArray(options) || options.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(part => typeof part !== 'string'))) throw new RoleCommandError('invalid_request', 'Options are --name value pairs.');
    if (request.input !== undefined && (!request.input || typeof request.input !== 'object' || Array.isArray(request.input))) throw new RoleCommandError('invalid_request', '--input is a JSON object.');
    const args = { ...(request.input as Record<string, unknown> | undefined), ...roleInput(tool.inputSchema as Schema, options as Array<[string, string]>) };
    const output = await tool.execute(args);
    let result: unknown = output;
    try { result = JSON.parse(output); } catch { /* A tool may answer with plain text. */ }
    return { result: result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { value: result } };
  } catch (error) {
    if (error instanceof RoleCommandError) return { error: { code: error.code, message: error.message } };
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : 'The role command failed.';
    return { error: { code: typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : message.startsWith('Invalid arguments for session tool') ? 'invalid_request' : 'command_failed', message } };
  }
}
