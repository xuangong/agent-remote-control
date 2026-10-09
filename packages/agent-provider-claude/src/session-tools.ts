import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { bindAgentSessionTools, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';

/** Keep Host callbacks in the SDK process and advertise their original JSON schemas. */
export function createClaudeSessionTools(definitions: readonly AgentSessionTool[], assertAvailable: () => void) {
  const tools = bindAgentSessionTools(definitions, assertAvailable);
  const server = createSdkMcpServer({ name: 'agent_host', version: '1.0.0' });
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
  return server;
}
