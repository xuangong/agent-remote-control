import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bindAgentSessionTools, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';

/** What Claude reads from a server when it connects; a server whose declaration changes must reconnect. */
export function claudeToolDeclaration(tools: readonly Pick<AgentSessionTool, 'name' | 'description' | 'inputSchema'>[]): string {
  return JSON.stringify(tools.map(({ name, description, inputSchema }) => [name, description, inputSchema]));
}

/** Keep Host callbacks in the SDK process and advertise their original JSON schemas, on a server named for Claude's tool names. */
export function createClaudeSessionTools(definitions: readonly AgentSessionTool[], assertAvailable: () => void, name = 'agent_host') {
  let tools = bindAgentSessionTools(definitions, assertAvailable);
  const server = createSdkMcpServer({ name, version: '1.0.0' });
  server.instance.server.registerCapabilities({ tools: {} });
  server.instance.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(({ name, description, inputSchema }) =>
    ({ name, description, inputSchema: inputSchema as { type: 'object'; [key: string]: unknown } })) }));
  server.instance.server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      assertAvailable();
      const tool = tools.find(tool => tool.name === request.params.name);
      if (!tool) throw new Error('Session tool is unavailable.');
      return { content: [{ type: 'text', text: await tool.execute(request.params.arguments ?? {}) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Session tool failed.' }] };
    }
  });
  const declaration = claudeToolDeclaration(tools);
  return { server, declaration,
    /** Replace the executors of the same declaration, keeping the connected server. */
    rebind(next: readonly AgentSessionTool[]) {
      const bound = bindAgentSessionTools(next, assertAvailable);
      if (claudeToolDeclaration(bound) !== declaration) throw new Error('Claude session tool declarations changed; reconnect the server.');
      tools = bound;
    } };
}
export type ClaudeSessionTools = ReturnType<typeof createClaudeSessionTools>;
