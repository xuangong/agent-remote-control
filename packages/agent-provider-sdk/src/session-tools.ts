import { Ajv } from 'ajv';
import type { AgentSessionTool, AgentSessionToolNamespace } from './provider.js';

// Codex reserves these Responses namespaces; agent_host is the Host's own Claude MCP server.
const RESERVED_NAMESPACES = new Set(['functions', 'multi_tool_use', 'file_search', 'web', 'browser', 'image_gen', 'computer', 'container',
  'terminal', 'python', 'python_user_visible', 'api_tool', 'tool_search', 'submodel_delegator', 'agent_host']);

export function bindAgentSessionToolNamespaces(namespaces: readonly AgentSessionToolNamespace[] = [], assertAvailable: () => void = () => {}): AgentSessionToolNamespace[] {
  const names = new Set<string>();
  return namespaces.map(namespace => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(namespace.name)) throw new Error('Session tool namespace names must match ^[a-zA-Z0-9_-]{1,64}$.');
    if (RESERVED_NAMESPACES.has(namespace.name)) throw new Error(`Session tool namespace ${namespace.name} is reserved.`);
    if (names.has(namespace.name)) throw new Error('Session tool namespace names must be unique.');
    names.add(namespace.name);
    if (typeof namespace.description !== 'string' || namespace.description.length > 1024) throw new Error(`Session tool namespace ${namespace.name} description must be at most 1,024 characters.`);
    return { name: namespace.name, description: namespace.description, ...(namespace.deferred ? { deferred: true } : {}),
      tools: bindAgentSessionTools(namespace.tools, assertAvailable) };
  });
}

/** Validate local tool definitions before native creation, and arguments before Host effects. */
export function bindAgentSessionTools(tools: readonly AgentSessionTool[] = [], assertAvailable: () => void = () => {}): AgentSessionTool[] {
  const validator = new Ajv({ strict: true, allowUnionTypes: true, allErrors: true });
  const names = new Set<string>();
  return tools.map(tool => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name)) throw new Error('Session tool names must be valid and unique.');
    names.add(tool.name);
    if (typeof tool.execute !== 'function') throw new Error(`Session tool ${tool.name} requires a Host callback.`);
    let schema: Record<string, unknown>;
    try { schema = JSON.parse(JSON.stringify(tool.inputSchema)) as Record<string, unknown>; }
    catch (error) { throw new Error(`Session tool ${tool.name} requires a JSON schema.`, { cause: error }); }
    if (!schema || schema.type !== 'object') throw new Error(`Session tool ${tool.name} requires an object JSON schema.`);
    let validate;
    try { validate = validator.compile(schema); }
    catch (error) { throw new Error(`Session tool ${tool.name} has an invalid or unsupported JSON schema.`, { cause: error }); }
    return { name: tool.name, description: tool.description, inputSchema: schema, async execute(arguments_) {
      assertAvailable();
      if (!validate(arguments_)) throw new Error(`Invalid arguments for session tool ${tool.name}: ${validator.errorsText(validate.errors)}`);
      return tool.execute(arguments_);
    } };
  });
}
