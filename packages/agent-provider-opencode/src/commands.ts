import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import { validateCommandDirectory, type AgentCommand, type AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import { OpenCodeTransport } from './transport.js';
import type { OpenCodeSelection } from './settings.js';

const compactId = 'opencode:compact';
const documentationPrefix = 'opencode-command:';

/** Uses the native directory, including skill commands and MCP prompt commands. */
export class OpenCodeCommands {
  private readonly documentation = new Map<string, string>();
  private compactCommandId = compactId;
  constructor(private readonly transport: OpenCodeTransport, private readonly nativeId: string, private readonly cwd: string) {}

  async list(): Promise<AgentCommand[]> {
    const native = await this.transport.request(() => this.transport.client.command.list({ directory: this.cwd }));
    this.documentation.clear();
    const commands = native.map(command => {
      const locator = `${documentationPrefix}${encodeURIComponent(command.name)}`;
      if (typeof command.template === 'string') this.documentation.set(locator, command.template);
      return {
        id: command.name, name: command.name, description: command.description ?? '',
        kind: command.source === 'skill' ? 'skill' as const : command.source === 'mcp' ? 'prompt' as const : 'command' as const,
        ...(command.hints?.length ? { inputHint: command.hints.join(' ') } : {}),
        ...(this.documentation.has(locator) ? { documentation: locator } : {}),
      };
    });
    // Preserve native commands named compact; expose the built-in under an unambiguous name.
    let compactName = 'compact';
    while (commands.some(command => command.name === compactName)) compactName = `opencode-${compactName}`;
    this.compactCommandId = compactId;
    while (commands.some(command => command.id === this.compactCommandId)) this.compactCommandId = `opencode:${this.compactCommandId}`;
    commands.push({ id: this.compactCommandId, name: compactName, description: 'Compact the native session conversation.', kind: 'command' });
    return validateCommandDirectory(commands);
  }

  async execute(id: string, args: string, selected: OpenCodeSelection, messageID: string, compactionModel: () => { providerID: string; modelID: string }, beforeDispatch: () => void = () => {}): Promise<void> {
    if (this.transport.restricted) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode native execution is locked by Host policy.');
    if (!(await prepareAgentOperation(() => this.list())).some(command => command.id === id)) throw new AgentOperationRejectedError('operation_rejected', 'Unknown OpenCode command.');
    const parameters = { sessionID: this.nativeId, directory: this.cwd };
    if (id === this.compactCommandId) {
      if (args.trim()) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode compact does not accept arguments.');
      const model = compactionModel();
      beforeDispatch();
      await this.transport.request(() => this.transport.client.session.summarize({ ...parameters, ...model, auto: false }));
      return;
    }
    beforeDispatch();
    await this.transport.request(() => this.transport.client.session.command({
      ...parameters, command: id, arguments: args, messageID,
      model: selected.model, agent: selected.agent, variant: selected.variant,
    }));
  }

  ownsResource(locator: string): boolean { return locator.startsWith(documentationPrefix); }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    if (!this.ownsResource(locator)) return { status: 'unavailable', reason: 'Unknown OpenCode command documentation.' };
    // Refresh the native catalog so deleted or changed skills do not serve stale instructions.
    await this.list();
    const text = this.documentation.get(locator);
    if (text === undefined) return { status: 'unavailable', reason: 'OpenCode command documentation is no longer available.' };
    return { status: 'available', bytes: new TextEncoder().encode(text), mediaType: 'text/markdown; charset=utf-8' };
  }
}
