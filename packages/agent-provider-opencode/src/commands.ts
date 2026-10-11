import { AgentOperationRejectedError, prepareAgentOperation } from '@orchardworks/agent-provider-sdk';
import { validateCommandDirectory, type AgentCommand, type AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import { OpenCodeTransport } from './transport.js';

const compactId = 'opencode:compact';
const documentationPrefix = 'opencode-command:';

/** Native commands and skill references share a directory without conflating their dispatch. */
export class OpenCodeCommands {
  private readonly documentation = new Map<string, string>();
  private readonly skills = new Map<string, string>();
  private compactCommandId = compactId;
  constructor(private readonly transport: OpenCodeTransport, private readonly nativeId: string, private readonly cwd: string) {}

  async list(): Promise<AgentCommand[]> {
    const location = { directory: this.cwd };
    const [native, skills] = await Promise.all([
      this.transport.request(() => this.transport.client.command.list({ location })),
      this.transport.request(() => this.transport.client.skill.list({ location })),
    ]);
    this.documentation.clear();
    this.skills.clear();
    const commands: AgentCommand[] = native.data.map(command => ({
      id: command.name, name: command.name, description: command.description ?? '', kind: 'command',
    }));
    for (const skill of skills.data) {
      let id = `opencode:skill:${skill.id}`;
      while (commands.some(command => command.id === id)) id = `opencode:${id}`;
      let name = skill.name;
      while (commands.some(command => command.name === name)) name = `opencode-${name}`;
      const documentation = `${documentationPrefix}${encodeURIComponent(skill.id)}`;
      this.skills.set(id, skill.id);
      this.documentation.set(documentation, skill.content);
      commands.push({ id, name, description: skill.description ?? '', kind: 'skill', documentation });
    }
    let compactName = 'compact';
    while (commands.some(command => command.name === compactName)) compactName = `opencode-${compactName}`;
    this.compactCommandId = compactId;
    while (commands.some(command => command.id === this.compactCommandId)) this.compactCommandId = `opencode:${this.compactCommandId}`;
    commands.push({ id: this.compactCommandId, name: compactName, description: 'Compact the native session conversation.', kind: 'command' });
    return validateCommandDirectory(commands);
  }

  async execute(id: string, args: string, messageID: string, beforeDispatch: () => void = () => {}): Promise<void> {
    if (this.transport.restricted) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode native execution is locked by Host policy.');
    if (!(await prepareAgentOperation(() => this.list())).some(command => command.id === id)) throw new AgentOperationRejectedError('operation_rejected', 'Unknown OpenCode command.');
    if (id === this.compactCommandId) {
      if (args.trim()) throw new AgentOperationRejectedError('operation_rejected', 'OpenCode compact does not accept arguments.');
      beforeDispatch();
      await this.transport.request(() => this.transport.client.session.compact({ sessionID: this.nativeId, id: messageID }));
      return;
    }
    const skill = this.skills.get(id);
    beforeDispatch();
    if (skill !== undefined) {
      await this.transport.request(() => this.transport.client.session.prompt({ sessionID: this.nativeId, id: messageID, text: args, skills: [{ id: skill }] }));
    } else {
      await this.transport.request(() => this.transport.client.session.command({ sessionID: this.nativeId, name: id, text: args }));
    }
  }

  ownsResource(locator: string): boolean { return locator.startsWith(documentationPrefix); }

  async readResource(locator: string): Promise<AgentResourceReadResult> {
    if (!this.ownsResource(locator)) return { status: 'unavailable', reason: 'Unknown OpenCode command documentation.' };
    await this.list();
    const text = this.documentation.get(locator);
    if (text === undefined) return { status: 'unavailable', reason: 'OpenCode command documentation is no longer available.' };
    return { status: 'available', bytes: new TextEncoder().encode(text), mediaType: 'text/markdown; charset=utf-8' };
  }
}
