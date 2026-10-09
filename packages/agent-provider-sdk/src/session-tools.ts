import { Ajv } from 'ajv';
import type { AgentSessionTool } from './provider.js';

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
