import type { AgentInteractionRequest, AgentInteractionResponse } from './control.js';
import type { AgentStreamEvent } from './observation.js';
import { redactInteractionRequest, redactInteractionResponse, validateInteractionResponse } from './interactions.js';

export interface AgentCommand {
  id: string;
  name: string;
  description: string;
  kind: 'command' | 'skill' | 'prompt';
  inputHint?: string;
  shortDescription?: string;
  /** Provider-owned resource locator for read-only command documentation. */
  documentation?: string;
}

export interface AgentCommandResult { text?: string; }

export function validateCommandDirectory(commands: AgentCommand[]): AgentCommand[] {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const command of commands) {
    if (!command.id || ids.has(command.id) || !/^[^\s/]+$/u.test(command.name) || names.has(command.name)
      || typeof command.description !== 'string' || !['command', 'skill', 'prompt'].includes(command.kind)
      || (command.inputHint !== undefined && typeof command.inputHint !== 'string')
      || (command.shortDescription !== undefined && typeof command.shortDescription !== 'string')
      || (command.documentation !== undefined && (typeof command.documentation !== 'string' || !command.documentation.trim()))) throw new Error('Invalid native command directory.');
    ids.add(command.id);
    names.add(command.name);
  }
  return commands.map((command) => ({ ...command }));
}

type CommandRequest = Omit<Extract<AgentInteractionRequest, { kind: 'question' }>, 'requestId'>
  | Omit<Extract<AgentInteractionRequest, { kind: 'form' }>, 'requestId'>;
interface PendingCommandInteraction {
  request: AgentInteractionRequest;
  handler(response: AgentInteractionResponse): Promise<void>;
  submitting: boolean;
}

/** Command menus share the same response validation and events as native interactions. */
export class CommandInteractions {
  private readonly requests = new Map<string, PendingCommandInteraction>();
  private readonly prefix = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  private sequence = 0;
  constructor(private readonly provider: string, private readonly emit: (event: AgentStreamEvent) => void) {}

  get pending(): boolean { return this.requests.size > 0; }

  open(request: CommandRequest, handler: PendingCommandInteraction['handler']): string {
    const requestId = `command:${this.prefix}:${++this.sequence}`;
    const full = { ...JSON.parse(JSON.stringify(request)) as CommandRequest, requestId };
    this.requests.set(requestId, { request: full, handler, submitting: false });
    this.emit({ type: 'interaction_requested', provider: this.provider, request: redactInteractionRequest(full) });
    return requestId;
  }

  async respond(requestId: string, response: AgentInteractionResponse): Promise<boolean> {
    const pending = this.requests.get(requestId);
    if (!pending) return false;
    if (pending.submitting) throw new Error('Command interaction response is already pending.');
    validateInteractionResponse(pending.request, response);
    pending.submitting = true;
    try {
      const canceled = response.kind === 'question' ? response.dismissed === true
        : response.kind === 'form' && response.action !== 'submit';
      if (!canceled) await pending.handler(response);
      if (this.requests.get(requestId) === pending) {
        this.requests.delete(requestId);
        this.emit({ type: 'interaction_resolved', provider: this.provider, requestId, response: redactInteractionResponse(pending.request, response) });
      }
      return true;
    } finally { pending.submitting = false; }
  }

  clear(): void { this.requests.clear(); }
}
