import { randomUUID } from 'node:crypto';
import { TurnCauses, type TurnReport } from './session-core/chain-turns.js';
import type { AgentSessionTool, AgentSessionToolNamespace } from '@orchardworks/agent-provider-sdk';
import { ASSISTANT_MESSAGE_LIMIT, BOT_MESSAGE_LIMIT, nativeSessionRefKey, ROOM_MINUTES_LIMIT, TASK_BRIEF_LIMIT, TASK_TITLE_LIMIT, type NativeSessionRef, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { botInstructions } from './bot-instructions.js';

export interface BotToolsPorts {
  request(call: TeamHostCall): Promise<unknown>;
  /** The Relay acknowledged bots. */
  tasks(): boolean;
  /** A session's title, which a bot's brief names it by. */
  title?(ref: NativeSessionRef): Promise<string | undefined>;
  /** The commit checked out in a session's working directory, where a worktree task starts. */
  head?(ref: NativeSessionRef): Promise<string>;
  /** The provider keeps a session it starts from writing its working directory. */
  readOnly?(providerId: string): boolean;
  /** A bounded page of a session's recent conversation on this Host. */
  read?(ref: NativeSessionRef, before?: { epoch: string; seq: number }): Promise<unknown>;
  /** A worktree bot's patch, saved on this Host, as the line its chief reads; undefined for any other bot. */
  patch?(ref: NativeSessionRef): Promise<string | undefined>;
}
/** Which tools a session has: none, or every bot's tools. */
export type WorkerTools = 'none' | 'tasks';

export const WORKER_NAMESPACE = 'agent_remote';
/** The tools a session was given: a listed (not deferred) bots' namespace. */
export function workerToolsIn(namespaces: readonly AgentSessionToolNamespace[] | undefined): WorkerTools {
  return namespaces?.some(namespace => namespace.name === WORKER_NAMESPACE && !namespace.deferred) ? 'tasks' : 'none';
}
const id = { type: 'string', minLength: 1, maxLength: 256 };
const object = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
const fail = (message: string): never => { throw new Error(message); };
const tool = (name: string, description: string, inputSchema: Record<string, unknown>, execute: (args: any) => Promise<unknown>): AgentSessionTool =>
  ({ name, description, inputSchema, execute: async args => JSON.stringify(await execute(args)) });

/** Every bot's tools, and which of this Host's sessions are bots, with their missions (bots design 5.1). */
export class BotTools {
  /** The bots' main sessions on this Host, with their missions. */
  private bots = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private polling = false;
  private loadedOnce = false;
  private polled?: Promise<void>;
  /** What started each session's latest turn, which a bot's calls carry (bots design 7). */
  readonly causes = new TurnCauses();
  constructor(private readonly ports: BotToolsPorts) {}
  /** A bot's turn ended: its Relay counts the turn and its usage in the turn's chain. */
  turnEnded(ref: NativeSessionRef, turn: TurnReport): void {
    if (this.tools(ref) !== 'tasks') return;
    void this.ports.request({ action: 'chain_turn', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, cause: turn.cause, tokens: turn.tokens,
      ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}) }).catch(() => undefined);
  }
  /** Whether the session is offered the bots' namespace: it is a bot's main session. */
  enabled(ref: NativeSessionRef): boolean { return this.tools(ref) !== 'none'; }
  /** The tools the session is offered. */
  tools(ref: NativeSessionRef): WorkerTools {
    return this.ports.tasks() && this.bots.has(nativeSessionRefKey(ref)) ? 'tasks' : 'none';
  }
  /** The standing instructions of a bot's main session (base instructions and its mission); undefined for a session that is no bot. */
  standing(ref: NativeSessionRef): string | undefined {
    const mission = this.bots.get(nativeSessionRefKey(ref));
    return mission === undefined ? undefined : botInstructions(mission || undefined);
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /**
   * Waits, at most `limitMs`, until enablement has been read once since the Controller started, so a session that opens right after a
   * restart still gets its standing instructions and tools. A Relay that does not answer in time leaves the session as it is.
   */
  async loaded(controllerId: string, limitMs = 3000): Promise<void> {
    if (this.loadedOnce || !this.ports.tasks()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([(this.polled ?? this.refresh(controllerId)).catch(() => undefined), new Promise<void>(resolve => { timer = setTimeout(resolve, limitMs); })]);
    clearTimeout(timer);
  }
  /** Reads enablement from the Relay; listeners hear about any change. */
  async refresh(controllerId: string): Promise<void> {
    if (this.polling || !this.ports.tasks()) return this.polled;
    this.polling = true;
    this.polled = this.read(controllerId).finally(() => { this.polling = false; this.polled = undefined; });
    return this.polled;
  }
  private async read(controllerId: string): Promise<void> {
    const value = await this.ports.request({ action: 'bot_enablement' }) as { bots?: unknown };
    if (!value || !Array.isArray(value.bots)) throw new Error('Invalid bot enablement.');
    const bots = new Map<string, string>();
    for (const entry of value.bots as Array<{ providerId?: unknown; nativeSessionId?: unknown; mission?: unknown }>) {
      if (typeof entry?.providerId === 'string' && typeof entry.nativeSessionId === 'string')
        bots.set(nativeSessionRefKey({ controllerId, providerId: entry.providerId, nativeSessionId: entry.nativeSessionId }), typeof entry.mission === 'string' ? entry.mission : '');
    }
    const changed = bots.size !== this.bots.size || [...bots].some(([key, mission]) => this.bots.get(key) !== mission);
    this.bots = bots; this.loadedOnce = true;
    if (changed) for (const listener of this.listeners) { try { listener(); } catch { /* Listeners cannot stop enablement. */ } }
  }
  /**
   * Every bot's tools, bound to the session that runs them. deferred: found by search rather than listed. The Relay refuses them from a
   * session that is no bot.
   */
  namespace(actual: () => NativeSessionRef | undefined, deferred: boolean): AgentSessionToolNamespace {
    const worker = () => actual() ?? fail('Bots are not attached to this session yet.');
    const taskRequest = async (input: TeamHostCall) => { if (!this.ports.tasks()) fail('Update the Relay to use tasks.'); return this.ports.request(input); };
    const caller = () => { const ref = worker(); return { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }; };
    // What started the caller's turn, so the Relay finds its chain.
    const cause = () => { const found = this.causes.of(worker()); return found ? { cause: found } : {}; };
    const coordination = [
      tool('create_bot', 'Start a bot: a session of Agent Remote Control that the person sees and can talk to, unlike your own subagents. Use it whenever you are asked for bots. lifetime temporary (default) is for one piece of work: it runs in parallel on this Host in a session of its own, while you keep talking with the person, and reports back to you as input labelled [Task … · done] or [Task … · failed], or asks you [Task … · question]. Give it a short name and a mission that stands alone: it sees only the mission and its first message, and reads your conversation only if the mission says so. workspace: same (default) works in your working directory alongside you; read_only investigates it without changing it; worktree works in its own git worktree at your current commit and returns its changes as a patch. provider and model choose another agent or model. lifetime standing creates a bot that stays, with its own place in your group and in the person\'s chats, for a role your work keeps needing (a reviewer, a tester); it reads its mission and reports in, and you work with it by message. Then tell the person what you started. Reuse operationId to retry after a lost response.',
        object({ name: { type: 'string', minLength: 1, maxLength: TASK_TITLE_LIMIT }, mission: { type: 'string', minLength: 1, maxLength: TASK_BRIEF_LIMIT },
          message: { type: 'string', minLength: 1, maxLength: BOT_MESSAGE_LIMIT }, lifetime: { type: 'string', enum: ['temporary', 'standing'] }, workspace: { type: 'string', enum: ['same', 'read_only', 'worktree'] }, provider: id,
          model: { type: 'string', minLength: 1, maxLength: 256 }, operationId: id }, ['name', 'mission']),
        async args => {
          const ref = worker(), title = await this.ports.title?.(ref).catch(() => undefined);
          const workspace = args.workspace as 'same' | 'read_only' | 'worktree' | undefined;
          if (workspace === 'read_only' && !this.ports.readOnly?.(args.provider ?? ref.providerId)) fail('This agent cannot work read-only here; use workspace worktree or same.');
          const commit = workspace === 'worktree' ? await (this.ports.head ?? (() => fail('Worktree bots are not available on this Host.')))(ref) : undefined;
          return taskRequest({ action: 'create_bot', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId, ...(title ? { title: title.slice(0, 256) } : {}) },
            operationId: args.operationId ?? randomUUID(), name: args.name, mission: args.mission, lifetime: args.lifetime ?? 'temporary', ...cause(), ...(args.message ? { message: args.message } : {}),
            ...(workspace && workspace !== 'same' ? { workspace } : {}), ...(commit ? { commit } : {}), ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}) });
        }),
      tool('message', 'Send a message to another bot, in your own words and at most 300 characters: one of your staff, your chief (to: "chief"), any bot from list_bots by name or id, or a room you are in when it is your turn there (to: the room\'s name or id; pass: true when you have nothing to add; status done with the room\'s result when it has reached it). When you write to your chief, status says what it is: progress, done or failed (your result, once), or needs_input (you wait for its answer; then end your turn). The details stay where they are: the receiver reads them with read_bot when it needs them. Answer a message another bot sent you with reply_to set to its id. It arrives between the receiver\'s turns. Reuse operationId to retry.',
        object({ to: { type: 'string', minLength: 1, maxLength: 300 }, text: { type: 'string', minLength: 1, maxLength: BOT_MESSAGE_LIMIT }, status: { type: 'string', enum: ['progress', 'done', 'failed', 'needs_input'] },
          reply_to: { type: 'string', pattern: '^m[0-9a-f]{12}$' }, pass: { type: 'boolean' }, operationId: id }, ['to', 'text']),
        async args => {
          // A worktree bot's result carries the path of its patch, saved on this Host where its chief works.
          const patch = args.status === 'done' || args.status === 'failed' ? await this.ports.patch?.(worker()) : undefined;
          return taskRequest({ action: 'bot_message', owner: caller(), operationId: args.operationId ?? randomUUID(), to: args.to, text: args.text, ...(patch ? { patch } : {}), ...cause(),
            ...(args.status ? { status: args.status } : {}), ...(args.reply_to ? { replyTo: args.reply_to } : {}), ...(args.pass === true ? { pass: true } : {}) });
        }),
      tool('list_bots', 'List the bots you can message: your staff with their status, your chief if you have one, and the standing bots of this account with their missions.',
        object({}, []), () => taskRequest({ action: 'list_bots', owner: caller() })),
      tool('read_bot', 'Read a bounded page of the recent conversation of one of your staff, to see what it did without asking it. Pass before from a previous page to read further back.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 }, before: { type: 'object', properties: { epoch: { type: 'string' }, seq: { type: 'integer' } }, required: ['epoch', 'seq'], additionalProperties: false } }, ['bot']),
        async args => {
          const where = await taskRequest({ action: 'bot_session', owner: caller(), bot: args.bot }) as { providerId: string; nativeSessionId: string };
          return (this.ports.read ?? (() => fail('Reading bots is not available on this Host.')))({ ...worker(), providerId: where.providerId, nativeSessionId: where.nativeSessionId }, args.before);
        }),
      tool('update_mission', 'Record a lasting change to how you work in your own mission, when the person or your chief told you something meant to last. Write the whole mission as it now stands. A temporary bot\'s mission is its brief and does not change.',
        object({ mission: { type: 'string', minLength: 1, maxLength: 4000 } }, ['mission']), args => taskRequest({ action: 'update_mission', owner: caller(), mission: args.mission })),
      tool('update_work', 'Keep a work item of yours, so the person and your chief see where your work stands without asking: create one with a title and a summary, or update one by its id (work). phase: clarifying, agreed, in_progress, verifying, waiting (for the person or another bot) or done. next says what happens next; acceptance how to tell it is done. While a work item is open, a quiet timer reminds you of it when nothing reaches you for a while. list_bots shows your work items. A temporary bot reports with message instead.',
        object({ work: { type: 'string', pattern: '^w_[0-9a-f]{12}$' }, title: { type: 'string', minLength: 1, maxLength: 120 }, phase: { type: 'string', enum: ['clarifying', 'agreed', 'in_progress', 'verifying', 'waiting', 'done'] },
          summary: { type: 'string', minLength: 1, maxLength: 300 }, next: { type: 'string', minLength: 1, maxLength: 300 }, acceptance: { type: 'string', minLength: 1, maxLength: 2000 } }, []),
        args => taskRequest({ action: 'update_work', owner: caller(), ...Object.fromEntries((['work', 'title', 'phase', 'summary', 'next', 'acceptance'] as const).flatMap(key => args[key] !== undefined ? [[key, args[key]]] : [])) })),
      tool('complete_work', 'Mark a work item of yours done, with a summary of the outcome in at most 300 characters.',
        object({ work: { type: 'string', pattern: '^w_[0-9a-f]{12}$' }, summary: { type: 'string', minLength: 1, maxLength: 300 } }, ['work', 'summary']),
        args => taskRequest({ action: 'complete_work', owner: caller(), work: args.work, summary: args.summary })),
      tool('set_timer', 'Set a named timer that reminds you after the given minutes of quiet: every message that reaches you pushes it back, so it only fires when nothing happens. Use it to look after work that waits on others. minutes 0 clears it.',
        object({ name: { type: 'string', minLength: 1, maxLength: 60 }, minutes: { type: 'integer', minimum: 0, maximum: 10080 } }, ['name', 'minutes']),
        args => taskRequest({ action: 'set_timer', owner: caller(), name: args.name, minutes: args.minutes })),
      tool('stop_bot', 'Stop one of your staff: its running turn stops and it gets no more input. Its conversation stays readable.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 } }, ['bot']), args => taskRequest({ action: 'stop_bot', owner: caller(), bot: args.bot })),
      tool('retire_bot', 'Retire one of your staff when its work is no longer needed, taking what it has done as its result.',
        object({ bot: { type: 'string', minLength: 1, maxLength: 300 } }, ['bot']), args => taskRequest({ action: 'retire_bot', owner: caller(), bot: args.bot })),
      tool('open_room', 'Open a room: a conversation of you and other assistants of this account (by name) about a topic, for a set number of minutes. The topic is your first message; the room then asks one member at a time to speak, with the messages it has not seen, and you are asked again when there is something new. The person sees the room and may write in it.',
        object({ name: { type: 'string', minLength: 1, maxLength: 120 }, topic: { type: 'string', minLength: 1, maxLength: ASSISTANT_MESSAGE_LIMIT },
          members: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 300 }, minItems: 1, maxItems: 7 }, minutes: { type: 'integer', minimum: 1, maximum: ROOM_MINUTES_LIMIT }, operationId: id }, ['name', 'topic', 'members', 'minutes']),
        args => { const ref = worker();
          return taskRequest({ action: 'open_room', owner: { providerId: ref.providerId, nativeSessionId: ref.nativeSessionId }, operationId: args.operationId ?? randomUUID(), name: args.name, topic: args.topic,
            members: args.members, minutes: args.minutes, ...cause() }); }),
    ];
    return { name: WORKER_NAMESPACE, description: 'Agent Remote Control: start bots that work in parallel and report back, message the account\'s other bots, keep your work items, and read and stop your staff.',
      ...(deferred ? { deferred: true } : {}), tools: coordination };
  }
}
