import type { AgentChildSession } from '@orchardworks/agent-provider-sdk';
import { ClaudeChildSession } from './child-session.js';
import type { ClaudeCatalog } from './catalog.js';
import { record } from './projector.js';

interface Child { taskId: string; view: ClaudeChildSession; background: boolean; refresh?: Promise<void> }
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const terminal = (status: unknown): AgentChildSession['status'] | undefined => status === 'failed' ? 'failed'
  : ['completed', 'stopped', 'killed'].includes(String(status)) ? 'closed' : undefined;

/** Native task identity and direct-parent ownership remain local to the adapter. */
export class ClaudeChildren {
  private readonly children = new Map<string, Child>();
  private readonly calls = new Map<string, Child>();
  private closed = false;
  constructor(private readonly parentId: string, private readonly cwd: string | undefined, private readonly catalog: ClaudeCatalog,
    private readonly changed: () => void) {}

  descriptors(): AgentChildSession[] { return [...this.children.values()].map(({ view }) => ({ ...view.descriptor })); }

  private declare(taskId: string, title: string, saved = false): Child {
    const nativeSessionId = `claude-child:${encodeURIComponent(this.parentId)}:${encodeURIComponent(taskId)}`;
    const descriptor: AgentChildSession = { nativeSessionId, title, createdAt: new Date().toISOString(),
      status: saved ? 'closed' : 'running', observation: saved ? 'saved_history' : 'live' };
    const child = { taskId, view: new ClaudeChildSession(descriptor, this.cwd), background: false };
    this.children.set(taskId, child);
    return child;
  }

  async restore(): Promise<void> {
    for (const saved of await this.catalog.children?.(this.parentId) ?? []) {
      if (!saved.messages.length || saved.messages.some((message) => message.parent_agent_id != null)) continue;
      const first = saved.messages.find((message) => message.type === 'user');
      const content = record(first?.message) ? first.message.content : undefined;
      const title = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((part) => record(part) && part.type === 'text').map((part) => part.text).join('\n') : undefined;
      const child = this.declare(saved.id, title?.slice(0, 160) || 'Saved Claude subagent', true);
      child.view.reconcileHistory(saved.messages);
    }
  }

  consume(message: Record<string, any>, turnId?: string): void {
    if (this.closed || message.session_id && message.session_id !== this.parentId) return;
    if (message.parent_tool_use_id) {
      this.calls.get(message.parent_tool_use_id)?.view.accept(message);
      return;
    }
    if (message.type !== 'system' || !text(message.task_id)) return;
    if (message.subtype === 'task_started') {
      if (message.task_type !== 'local_agent' || message.spawn_depth != null && message.spawn_depth !== 1
        || message.ambient || message.skip_transcript) return;
      const child = this.children.get(message.task_id) ?? this.declare(message.task_id, text(message.description) ?? 'Claude subagent');
      const descriptor = child.view.descriptor;
      descriptor.status = 'running'; descriptor.observation = 'live';
      descriptor.title = text(message.description) ?? descriptor.title;
      descriptor.description = text(message.prompt) ?? descriptor.description;
      descriptor.role = text(message.subagent_type) ?? descriptor.role;
      descriptor.parentTurnId ??= turnId;
      child.background = message.is_backgrounded === true;
      if (text(message.tool_use_id)) {
        descriptor.parentCallId ??= message.tool_use_id;
        this.calls.set(message.tool_use_id, child);
      }
      child.view.changed(); this.changed();
      return;
    }
    const child = this.children.get(message.task_id);
    if (!child) return;
    const patch = message.subtype === 'task_updated' && record(message.patch) ? message.patch : message;
    if (typeof patch.is_backgrounded === 'boolean') child.background = patch.is_backgrounded;
    const status = terminal(patch.status);
    if (!status) return;
    child.view.descriptor.status = status;
    child.view.descriptor.observation = 'saved_history';
    child.view.changed(); this.changed();
    // Background tasks may produce no forwarded transcript frames. Hydrate once native persistence settles.
    void this.refresh(child).catch(() => undefined);
  }

  async open(nativeSessionId: string): Promise<ClaudeChildSession> {
    const child = [...this.children.values()].find(({ view }) => view.descriptor.nativeSessionId === nativeSessionId);
    if (!child) throw new Error('Claude session is not a direct child of the loaded parent.');
    if (child.view.descriptor.observation === 'saved_history') {
      await this.refresh(child);
      if (!child.view.hasHistory) throw new Error('Claude child history is unavailable. Reopen the child to retry.');
    }
    return child.view;
  }

  private refresh(child: Child): Promise<void> {
    return child.refresh ??= (async () => {
      const messages = await this.catalog.childMessages?.(this.parentId, child.taskId) ?? [];
      if (messages.some((message) => message.parent_agent_id != null)) throw new Error('Claude child ownership changed.');
      if (messages.length) child.view.reconcileHistory(messages);
    })().finally(() => { child.refresh = undefined; });
  }

  finishTurn(): void {
    for (const child of this.children.values()) {
      if (child.background || child.view.descriptor.observation !== 'live') continue;
      // The root result ends foreground observation. It says nothing about background tasks.
      child.view.descriptor.status = 'closed';
      child.view.descriptor.observation = 'saved_history';
      child.view.changed();
      void this.refresh(child).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { view } of this.children.values()) {
      if (view.descriptor.status !== 'failed') view.descriptor.status = 'closed';
      view.descriptor.observation = 'saved_history'; view.changed();
    }
    await Promise.all([...this.children.values()].map(({ view }) => view.close()));
  }
}
