import { CommandInteractions, type AgentCommand, type AgentCommandResult, type AgentInteractionResponse, type AgentSessionSetting, type AgentStreamEvent } from '@orchardworks/agent-provider-sdk';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { AgentResourceReadResult } from '@orchardworks/agent-provider-sdk';
import { isRecord } from './native.js';
import type { DshSessionSettings } from './session-settings.js';

interface NativeCommand {
  name: string;
  description: string;
  input?: { hint: string };
}
interface NativeCommands {
  list(agent: Agent): readonly NativeCommand[];
  execute(agent: Agent, line: string, images: readonly never[], signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined>;
}

interface NativeSkill {
  name: string;
  description: string;
  invocation: { userInvocable: boolean };
  content?: string;
}
interface NativeSkills {
  list(options: { scope: Agent; cwd?: string }): Promise<NativeSkill[]>;
  get(name: string, options: { scope: Agent; cwd?: string }): Promise<NativeSkill | undefined>;
}

export class DshCommands {
  private readonly interactions: CommandInteractions;
  private execution: AbortController | undefined;
  private disposed = false;

  constructor(
    private readonly agent: Agent,
    private readonly service: (name: string) => unknown,
    private readonly settings: DshSessionSettings,
    emit: (event: AgentStreamEvent) => void,
    private readonly assertIdle: () => void,
  ) {
    this.interactions = new CommandInteractions('dsh', emit);
  }

  get supported(): boolean {
    const controller = this.service('sessionController');
    return this.native() !== undefined || this.skills() !== undefined || (isRecord(controller) && typeof controller.modelCatalog === 'function' && typeof controller.selectModel === 'function');
  }
  get documentsSupported(): boolean { return this.skills() !== undefined; }
  get pending(): boolean { return this.interactions.pending || this.execution !== undefined; }

  async list(): Promise<AgentCommand[]> {
    this.assertOpen();
    await this.settings.load();
    this.assertOpen();
    const native = this.native()?.list(this.agent) ?? [];
    const commands: AgentCommand[] = native.map((command) => ({
      id: `dsh:command:${command.name}`, name: command.name, description: command.description, kind: 'command',
      ...(command.input ? { inputHint: command.input.hint } : {}),
    }));
    if (!native.some(({ name }) => name === 'model')) {
      if (this.settings.describe().some((setting) => setting.id === 'model' && setting.mutable)) {
        commands.push({ id: 'dsh:selection:model', name: 'model', description: 'Select the session and default model.', kind: 'command' });
      }
    }
    for (const skill of await this.skills()?.list(this.skillContext()) ?? []) {
      if (!skill.invocation?.userInvocable || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name) || commands.some(({ name }) => name === skill.name)) continue;
      commands.push({ id: `dsh:skill:${skill.name}`, name: skill.name, description: skill.description, kind: 'skill',
        documentation: `dsh-skill:${skill.name}`, inputHint: 'Instructions for this skill' });
    }
    this.assertOpen();
    return commands;
  }

  async execute(id: string, args: string): Promise<AgentCommandResult> {
    this.assertOpen();
    if (this.pending) throw new Error('A DSH command or interaction is pending.');
    this.assertIdle();
    const abort = new AbortController();
    this.execution = abort;
    try {
      const command = (await this.list()).find((entry) => entry.id === id);
      this.assertOpen();
      abort.signal.throwIfAborted();
      this.assertIdle();
      if (!command) throw new Error('DSH command is unavailable.');
      if (command.kind === 'skill') {
        this.agent.followup(createUserMessage({ content: [{ type: 'text', text: `/${command.name}${args && !/^\s/.test(args) ? ' ' : ''}${args}` }], source: { kind: 'user' } }));
        return {};
      }
      if (id === 'dsh:selection:model') {
        if ((this.native()?.list(this.agent) ?? []).some(({ name }) => name === 'model')) throw new Error('DSH command is unavailable.');
        if (args.trim()) throw new Error('Choose a model from the native model menu.');
        this.openSelection('model');
        return {};
      }
      const result = await this.invoke(command.name, args, abort.signal);
      this.assertOpen();
      if (command.name === 'permission' && !args.trim()) {
        await this.settings.load();
        this.assertOpen();
        abort.signal.throwIfAborted();
        this.openSelection('permissions');
      }
      return result;
    } finally { if (this.execution === abort) this.execution = undefined; }
  }

  respond(requestId: string, response: AgentInteractionResponse): Promise<boolean> {
    this.assertOpen();
    return this.interactions.respond(requestId, response);
  }

  cancel(): boolean {
    const pending = this.pending;
    this.execution?.abort(new Error('DSH command was canceled.'));
    this.interactions.clear();
    return pending;
  }

  dispose(): void { this.disposed = true; this.cancel(); }

  async readDocumentation(locator: string): Promise<AgentResourceReadResult> {
    this.assertOpen();
    const command = (await this.list()).find((entry) => entry.documentation === locator);
    if (!command) return { status: 'unavailable', reason: 'Skill is no longer available in this session.' };
    const skill = await this.skills()?.get(command.name, this.skillContext());
    this.assertOpen();
    if (!skill?.invocation?.userInvocable || typeof skill.content !== 'string') return { status: 'unavailable', reason: 'Skill documentation is unavailable.' };
    const bytes = new TextEncoder().encode(skill.content);
    if (bytes.byteLength > 256 * 1024) return { status: 'unavailable', reason: 'Skill documentation exceeds the supported file limit.' };
    return { status: 'available', bytes, mediaType: 'text/plain' };
  }

  private skillContext(): { scope: Agent; cwd?: string } {
    return { scope: this.agent, ...(this.agent.session.header.cwd ? { cwd: this.agent.session.header.cwd } : {}) };
  }
  private skills(): NativeSkills | undefined {
    const value = this.service('skills');
    const tools = this.service('tools');
    if (!isRecord(tools) || typeof tools.get !== 'function' || !tools.get('skill', this.agent)) return undefined;
    return isRecord(value) && typeof value.list === 'function' && typeof value.get === 'function' ? value as unknown as NativeSkills : undefined;
  }

  private openSelection(id: 'model' | 'permissions'): void {
    const setting = this.settings.describe().find((entry) => entry.id === id && entry.mutable);
    if (!setting) return;
    this.interactions.open({ kind: 'question', questions: [{
      questionId: id, header: setting.label, prompt: `Select ${setting.label.toLowerCase()}`,
      ...(setting.description ? { description: setting.description } : {}),
      required: true, selection: 'single', options: setting.options, allowCustomText: false, allowDismiss: true,
    }] }, async (response) => {
      this.assertOpen();
      this.assertIdle();
      if (response.kind !== 'question') throw new Error('DSH command requires a question response.');
      const value = response.answers.find(({ questionId }) => questionId === id)?.selectedValues[0];
      if (!value) throw new Error('DSH command requires a selection.');
      const current = this.settings.describe().find((entry) => entry.id === id);
      validateChoice(current, value);
      const abort = new AbortController();
      this.execution = abort;
      try {
        if (id === 'permissions') {
          if (!(this.native()?.list(this.agent) ?? []).some(({ name }) => name === 'permission')) throw new Error('DSH command is unavailable.');
          await this.invoke('permission', value, abort.signal);
        } else {
          if ((this.native()?.list(this.agent) ?? []).some(({ name }) => name === 'model')) throw new Error('DSH model command changed; open the command again.');
          await this.settings.select('model', value);
        }
        this.assertOpen();
        if (abort.signal.aborted) throw abort.signal.reason;
      } finally { if (this.execution === abort) this.execution = undefined; }
    });
  }

  private async invoke(name: string, args: string, signal: AbortSignal): Promise<AgentCommandResult> {
    const separator = args && !/^[\t\n\r ]/.test(args) ? ' ' : '';
    if (!(this.native()?.list(this.agent) ?? []).some((command) => command.name === name)) throw new Error('DSH command is unavailable.');
    const execution = await this.native()?.execute(this.agent, `/${name}${separator}${args}`, [], signal);
    if (signal.aborted) throw signal.reason;
    if (!execution) throw new Error('DSH command is unavailable.');
    if (execution.result.kind !== 'success') throw new Error(execution.result.text ?? 'Native DSH command failed.');
    return execution.result.text === undefined ? {} : { text: execution.result.text };
  }

  private assertOpen(): void { if (this.disposed) throw new Error('DSH session is closed.'); }
  private native(): NativeCommands | undefined {
    const value = this.service('commands');
    return isRecord(value) && typeof value.list === 'function' && typeof value.execute === 'function' ? value as unknown as NativeCommands : undefined;
  }
}

function validateChoice(setting: AgentSessionSetting | undefined, value: string): void {
  if (!setting?.mutable || !setting.options.some((option) => option.value === value)) throw new Error('Native DSH choice is unavailable.');
}
