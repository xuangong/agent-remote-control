/**
 * A scripted provider for the e2e stack: sessions whose history and replies a flow decides.
 *
 * Contract. `scriptedProvider()` returns the Controller registration and a handle per session. A session starts with its native
 * `history`: plain rows, or the observations of a recording (`recordedHistory`). A message sent to it is echoed as a user row and
 * answered by `answer(text)` as an assistant row, immediately, after `replyDelayMs`, or streamed in pieces; a flow can hold the echo
 * (`hold`) to look at a message while it is pending. Native history is what a terminal and a reopened session read: `write` adds a row the
 * running session sees live, `terminalWrite` adds rows only to the native history, as a terminal does while the Controller's session
 * follows its own last message (the provider then reports the divergence, as the Claude one does, and the Controller reads it again).
 * `terminalTakes` makes a terminal the native owner of a session (the Controller lets the session go and refuses sends until a person takes it
 * back). `fork` adds a session whose history is a copy of another's, as a terminal fork does. Item keys are stable per session and position,
 * so a reload shows the same rows. The provider reads nothing outside this process.
 *
 * `turns(text)` scripts a whole turn instead of one answer: tool calls that run for a while and complete with an output, approvals that wait for the
 * page's answer (`respondToInteraction`), and replies. Every row of the turn carries one turn id; the session reports itself running with that
 * active turn until the turn ends, as a real provider does, and a denied approval ends it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { AgentRuntimeError, type AgentSessionTool, parseAgentPreparedTextInput, serializeAgentPreparedTextInput, type AgentInteractionResponse, type AgentProviderAdapter, type AgentToolDetail, type AgentSessionNativeEvidence, type ProviderObservation, type ProviderStreamItem } from '@orchardworks/agent-provider-sdk';
import type { AgentHostDirectory, AgentHostProviderRegistration } from '@orchardworks/agent-remote-controller';
import { NativeSessionOwnerError, type NativeOwnerIdentity } from '@orchardworks/agent-remote-controller/testing';
import { ScriptedSession } from '@orchardworks/agent-remote-fixtures';

export const SCRIPTED_PROVIDER = 'scripted';

/** `key` names the row for good: it keeps its item key when the rows before it change. Without one the key is the row's position. */
export interface ScriptedRow { role: 'user' | 'assistant'; text: string; key?: string }
/** One entry of a native history: a plain row, or an observation a real CLI produced (see `recordedHistory`). */
export type HistoryEntry = ScriptedRow | { observation: ProviderObservation };

/** The history of a recording: the observations of the session read again, in the order the provider gave them. */
export function recordedHistory(recording: { reread: ProviderObservation[] }): HistoryEntry[] {
  return recording.reread.map(observation => ({ observation: { ...observation, delivery: 'history' as const } }));
}

/** A timeline observation of one completed item of a scripted session. `completes` false gives a piece of a streamed item. */
export function row(providerId: string, delivery: 'history' | 'live', key: string, entry: ScriptedRow, sequence: number, completes = true, piece = 0): ProviderObservation {
  return {
    type: 'observation', sourceKey: `${delivery}:${key}:${piece}`, occurredAt: 1_725_000_000_000 + sequence, delivery,
    event: { type: 'timeline', provider: providerId, turnId: `turn-${Math.ceil(sequence / 2)}`,
      item: { type: entry.role === 'user' ? 'user_message' : 'assistant_message', text: entry.text, messageId: key } },
    itemIdentity: completes ? { key, completes: true } : { key },
  };
}

/** A tool detail as a flow writes it: a command string is a shell command, an object is the detail itself. */
export type ScriptedToolInput = string | AgentToolDetail;
/** One step of a scripted turn (`ScriptedProviderOptions.turns`). */
export type ScriptedStep =
  /** A tool call: a running `tool_call` row, then, after `ms`, the same item completed with `output`. */
  | { tool: string; input: ScriptedToolInput; output: string; ms?: number }
  /** A pending `tool_approval` of `command`; the turn waits until the page answers it. Allow goes on; deny or cancel ends the turn. */
  | { approval: string; command: string; toolName?: string }
  /** A pending `question` with one single-choice question that also takes free text; the turn goes on once the page answers it. */
  | { question: string; options: readonly string[] }
  /** An assistant message. */
  | { reply: string };

const toolDetail = (input: ScriptedToolInput): AgentToolDetail => typeof input === 'string' ? { type: 'shell', command: input } : input;

export interface ScriptedSessionHandle {
  readonly nativeSessionId: string;
  readonly title: string;
  readonly sent: string[];
  /** A row the way the running session adds it: the page sees it live and the native history keeps it. */
  write(role: ScriptedRow['role'], text: string): void;
}

export interface ScriptedProviderOptions {
  /** Sessions that exist when the Controller starts, with their history. */
  sessions?: Record<string, { title: string; history: HistoryEntry[] }>;
  providerId?: string;
  displayName?: string;
  answer?(text: string): string;
  /** Steps of the turn a sent text starts; when it returns steps, they replace `answer` for that text, and undefined leaves the text to `answer`. */
  turns?(text: string): ScriptedStep[] | undefined;
  replyDelayMs?: number;
  /** Answer in two pieces, as a model streams: the page shows the first before the second arrives. */
  stream?: boolean;
  /**
   * Makes the provider a successor target: it creates empty sessions, reports readiness, and takes a prepared input (the first message
   * after a handoff carries the quoted history). `workspace` is the directory the Controller's execution policy allows; `beforeCreate`
   * runs before a successor is created, so a flow can hold the handoff half done.
   */
  succession?: { workspace: string; beforeCreate?(): Promise<void> };
  /** A folder the directory offers as a workspace to browse and start sessions in; the Controller's execution policy has to allow it. */
  workspaceRoot?: string;
  /**
   * Sessions take tools as a namespace while they run (`live`), as Claude Code does: the Controller's tools reach them when they
   * open, are created or change, and a flow calls one in the model's place with `useTool`.
   */
  tools?: boolean;
  /** The working directory sessions report, as a real CLI does: Team seats, tasks and bots start where it is. */
  cwd?: string;
}

export function scriptedProvider(options: ScriptedProviderOptions = {}) {
  const providerId = options.providerId ?? SCRIPTED_PROVIDER;
  const answer = options.answer ?? (text => `Echo: ${text}`);
  interface Native { title: string; history: HistoryEntry[]; createdAt: string; updatedAt: string; diverged: boolean }
  const known = new Map<string, Native>();
  const startedAt = Date.parse('2026-11-18T00:00:00.000Z');
  for (const [id, session] of Object.entries(options.sessions ?? {})) known.set(id, { ...session, history: [...session.history], createdAt: new Date(startedAt).toISOString(), updatedAt: new Date(startedAt).toISOString(), diverged: false });
  const live = new Map<string, ScriptedSessionHandle & ScriptedSession>();
  /** What each session was given by the Controller: its instructions and its tools, as it opened, was created or was changed. */
  const given = new Map<string, { instructions?: string; tools: AgentSessionTool[] }>();
  const give = (id: string, extensions: { instructions?: string; tools?: readonly AgentSessionTool[]; toolNamespaces?: readonly { tools: readonly AgentSessionTool[] }[] } | undefined) => {
    if (!options.tools || !extensions) return;
    given.set(id, { ...(extensions.instructions ? { instructions: extensions.instructions } : {}), tools: [...(extensions.tools ?? []), ...(extensions.toolNamespaces ?? []).flatMap(namespace => namespace.tools)] });
  };
  let created = 0;
  /** The working directory each session the page created was started in. */
  const startedIn = new Map<string, string | undefined>();
  let held: Promise<void> | undefined;
  const owners = new Map<string, NativeOwnerIdentity>();
  let handoff: ((nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>) | undefined;

  const observation = (id: string, entry: HistoryEntry, at: number, delivery: 'history' | 'live'): ProviderObservation =>
    'observation' in entry ? { ...entry.observation, delivery } : row(providerId, delivery, `${id}:${entry.key ?? `h${at}`}`, entry, at);

  const open = (nativeSessionId: string): ScriptedSession => {
    const saved = known.get(nativeSessionId);
    if (!saved) throw new AgentRuntimeError('native_session_unavailable', `No scripted session ${nativeSessionId}.`);
    saved.diverged = false;
    const items: ProviderStreamItem[] = [...saved.history.map((entry, at) => observation(nativeSessionId, entry, at + 1, 'history')), { type: 'history_boundary' }];
    const base = new ScriptedSession(providerId, nativeSessionId, items);
    const sent: string[] = [];
    const write = (role: ScriptedRow['role'], text: string) => {
      saved.history.push({ role, text });
      saved.updatedAt = new Date().toISOString();
      base.push(row(providerId, 'live', `${nativeSessionId}:h${saved.history.length}`, { role, text }, saved.history.length));
    };
    /**
     * The answer as a model streams it: two pieces under one item key, then the completed item. It takes its place in the history as it
     * starts, as a native transcript does, so a message written while it streams comes after it with a key of its own.
     */
    const writeStreamed = (text: string) => {
      const half = Math.ceil(text.length / 2);
      const entry = { role: 'assistant' as const, text: text.slice(0, half) };
      saved.history.push(entry); saved.updatedAt = new Date().toISOString();
      const at = saved.history.length;
      const key = `${nativeSessionId}:h${at}`;
      base.push(row(providerId, 'live', key, { role: 'assistant', text: text.slice(0, half) }, at, false, 1));
      setTimeout(() => {
        base.push(row(providerId, 'live', key, { role: 'assistant', text: text.slice(half) }, at, false, 2));
        entry.text = text; saved.updatedAt = new Date().toISOString();
        base.push(row(providerId, 'live', key, { role: 'assistant', text: '' }, at, true, 3));
      }, options.replyDelayMs ?? 300);
    };
    /** A scripted turn: the rows and state events of a real provider's turn, under one turn id. */
    const pendingApprovals = new Map<string, (response: AgentInteractionResponse) => void>();
    let turnCount = 0, eventCount = 0, status: 'idle' | 'running' = 'idle';
    const runtimeInfo = () => ({ providerId, sessionId: nativeSessionId, status, ...(options.succession ? { cwd: options.succession.workspace } : options.workspaceRoot ? { cwd: startedIn.get(nativeSessionId) ?? options.workspaceRoot } : options.cwd ? { cwd: startedIn.get(nativeSessionId) ?? options.cwd } : {}),
      persistence: { providerId, sessionId: nativeSessionId, opaque: '{}' } });
    const playTurn = async (text: string, steps: ScriptedStep[]) => {
      const turnId = `${nativeSessionId}-turn-${++turnCount}`;
      const emit = (event: ProviderObservation['event'], sourceKey: string, itemIdentity?: ProviderObservation['itemIdentity']) =>
        base.push({ type: 'observation', sourceKey: `live:${sourceKey}:${++eventCount}`, occurredAt: Date.now(), delivery: 'live', event, ...(itemIdentity ? { itemIdentity } : {}) });
      const running = (next: typeof status) => {
        status = next;
        emit({ type: 'runtime_updated', provider: providerId, runtimeInfo: runtimeInfo(), activeTurnId: next === 'running' ? turnId : null }, `runtime-${next}`);
      };
      running('running');
      const message = (role: ScriptedRow['role'], body: string) => {
        const key = `${nativeSessionId}:h${saved.history.length + 1}`;
        saved.history.push({ role, text: body }); saved.updatedAt = new Date().toISOString();
        emit({ type: 'timeline', provider: providerId, turnId, item: { type: role === 'user' ? 'user_message' : 'assistant_message', text: body, messageId: key } }, key, { key, completes: true });
      };
      emit({ type: 'turn_started', provider: providerId, turnId }, 'turn-started');
      message('user', text);
      for (const [index, step] of steps.entries()) {
        const callId = `${nativeSessionId}:${turnId}:c${index}`;
        if ('reply' in step) message('assistant', step.reply);
        else if ('tool' in step) {
          const item = { type: 'tool_call' as const, callId, name: step.tool, detail: toolDetail(step.input) };
          emit({ type: 'timeline', provider: providerId, turnId, item: { ...item, status: 'running', error: null } }, `${callId}:started`, { key: callId });
          if (step.ms) await new Promise(resolve => setTimeout(resolve, step.ms));
          emit({ type: 'timeline', provider: providerId, turnId, item: { ...item, status: 'completed', error: null, result: { content: [{ type: 'text', text: step.output }], exitCode: 0, durationMs: step.ms ?? 0 } } }, `${callId}:completed`, { key: callId, completes: true });
        } else if ('question' in step) {
          const requestId = `${turnId}:question-${index}`;
          const answered = new Promise<AgentInteractionResponse>(resolve => pendingApprovals.set(requestId, resolve));
          emit({ type: 'interaction_requested', provider: providerId, turnId, request: { kind: 'question', requestId, questions: [{ questionId: 'choice', header: 'Choice', prompt: step.question,
            required: true, selection: 'single', options: step.options.map(option => ({ value: option, label: option })), allowCustomText: true, allowDismiss: false }] } }, `${requestId}:requested`);
          const response = await answered;
          emit({ type: 'interaction_resolved', provider: providerId, turnId, requestId, response }, `${requestId}:resolved`, { key: `interaction:${requestId}`, completes: true, liveOnly: true });
        } else {
          const requestId = `${turnId}:approval-${index}`;
          const answered = new Promise<AgentInteractionResponse>(resolve => pendingApprovals.set(requestId, resolve));
          emit({ type: 'interaction_requested', provider: providerId, turnId, request: { kind: 'tool_approval', requestId, toolCallId: callId, toolName: step.toolName ?? 'command', summary: step.approval,
            detail: { type: 'shell', command: step.command }, allowedDecisions: ['allow', 'deny'], allowScopes: ['once'] } }, `${requestId}:requested`);
          const response = await answered;
          emit({ type: 'interaction_resolved', provider: providerId, turnId, requestId, response }, `${requestId}:resolved`, { key: `interaction:${requestId}`, completes: true, liveOnly: true });
          if (response.kind === 'tool_approval' && response.decision !== 'allow') break;
        }
      }
      emit({ type: 'turn_completed', provider: providerId, turnId }, 'turn-completed');
      running('idle');
    };
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    let epoch = 0, preparations = 0;
    const evidence = (workspace: string): AgentSessionNativeEvidence => ({
      availability: () => ({ status: 'configured', version: 2 }),
      inspectReadiness: async () => ({ cwd: workspace, idle: true, pendingInputs: 0, pendingInteractions: 0, activeChildren: 0 }),
      captureValidity: () => ({ epoch }) as never,
      isCurrent: token => (token as unknown as { epoch: number }).epoch === epoch,
      prepareInput: async parts => {
        const text = (parts[0] as { text: string }).text;
        return parseAgentPreparedTextInput(serializeAgentPreparedTextInput({ version: 2, providerId, nativeSessionId, inputId: `${nativeSessionId}-U-${++preparations}`, cwd: workspace,
          authority: { kind: 'trusted-service', authorityId: 'e2e', namespaceId: 'owned' }, parts: [{ type: 'text', text }],
          content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: sha256(text) }, selections: { model: 'scripted/model' } }));
      },
      dispatchInput: async witness => {
        const text = witness.parts[0].text;
        sent.push(text); epoch += 1;
        const steps = options.turns?.(text);
        if (steps) { void playTurn(text, steps); return { disposition: 'started' }; }
        write('user', text);
        if (options.stream) writeStreamed(answer(text)); else write('assistant', answer(text));
        return { disposition: 'started' };
      },
      inspectInput: async witness => ({ status: 'materialized', execution: { disposition: 'started', nativeExecutionId: `${witness.inputId}-R` }, proof: { version: 2, providerId, nativeSessionId,
        inputId: witness.inputId, nativeInputId: witness.inputId, cwd: workspace, authority: witness.authority, witnessSha256: sha256(serializeAgentPreparedTextInput(witness)),
        contentSha256: witness.content.sha256, nativeSelectionsSha256: sha256(JSON.stringify(witness.selections)) } }),
    });
    const session = Object.assign(base, {
      title: saved.title, sent, write, runtimeInfo: async () => runtimeInfo(),
      ...(options.succession ? { nativeEvidence: evidence(options.succession.workspace) } : {}),
      sendMessage: (async (text: string) => {
        await held;
        sent.push(text);
        const steps = options.turns?.(text);
        if (steps) { void playTurn(text, steps); return; }
        write('user', text);
        if (options.stream) writeStreamed(answer(text));
        else if (options.replyDelayMs) setTimeout(() => write('assistant', answer(text)), options.replyDelayMs);
        else write('assistant', answer(text));
      }) as unknown as ScriptedSession['sendMessage'],
      /** The page's answer to a scripted approval resolves it and the turn goes on. */
      respondToInteraction: (async (requestId: string, response: AgentInteractionResponse) => {
        const resolve = pendingApprovals.get(requestId);
        if (!resolve) throw new Error(`No pending scripted interaction ${requestId}.`);
        pendingApprovals.delete(requestId);
        resolve(response);
      }) as ScriptedSession['respondToInteraction'],
    });
    if (options.tools) (session as ScriptedSession & { updateToolNamespaces?(namespaces: readonly { tools: readonly AgentSessionTool[] }[]): Promise<void> }).updateToolNamespaces = async namespaces => {
      given.set(nativeSessionId, { ...given.get(nativeSessionId), tools: namespaces.flatMap(namespace => namespace.tools) });
    };
    live.set(nativeSessionId, session);
    return session;
  };

  const adapter: AgentProviderAdapter = {
    descriptor: { providerId, displayName: options.displayName ?? 'Scripted', ...(options.tools ? { sessionExtensions: { instructions: true, tools: true, toolNamespaces: 'live' as const } } : options.succession ? { sessionExtensions: { instructions: true, tools: true } } : {}) },
    journal: { itemIdentity: 1 as const },
    ...(options.succession ? { readSessionHistory: async () => ({ entries: [] }), nativeEvidence: {
      availability: () => ({ status: 'configured' as const, version: 2 as const }),
      createEmpty: async () => {
        await options.succession!.beforeCreate?.();
        const id = `${providerId}-successor-${++created}`;
        known.set(id, { title: 'Successor', history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diverged: false });
        return { status: 'created' as const, handle: { providerId, sessionId: id, opaque: `scripted-${id}` } };
      },
    } } : {}),
    async createSession() { throw new Error('The Host supplies directory sessions.'); },
    async resumeSession() { throw new Error('The Host supplies directory sessions.'); },
  };
  const directory: AgentHostDirectory = {
    providerId,
    list: async () => [...known].map(([nativeSessionId, saved]) => ({ nativeSessionId, providerId, title: saved.title, createdAt: saved.createdAt, updatedAt: saved.updatedAt, state: 'idle' as const })),
    workspaces: async () => options.workspaceRoot ? [{ id: 'root', name: 'Projects', path: options.workspaceRoot }] : [],
    create: async config => { const id = `${providerId}-new-${++created}`; startedIn.set(id, config.cwd); give(id, config); known.set(id, { title: 'New session', history: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diverged: false }); return id; },
    canReleaseSession: () => true,
    ...(options.workspaceRoot && !options.succession ? { sessionWorkspace: async (nativeSessionId: string) => startedIn.get(nativeSessionId) ?? options.workspaceRoot! } : {}),
    ...(options.succession ? { sessionWorkspace: async () => options.succession!.workspace, supportsSourceReferences: true, supportsBoundedSourceCreate: async () => true,
      sourceReferences: async () => [], setSourceBindingReader: () => {} } : {}),
    // A session that something else wrote to continues from its own last message; the Controller releases it and reads it again.
    divergedAt: (nativeSessionId: string) => known.get(nativeSessionId)?.diverged ? 1 : undefined,
    checkDivergence: async (nativeSessionId: string) => known.get(nativeSessionId)?.diverged ?? false,
    setSessionHandoffHandler(handler: (nativeSessionId: string, next: NativeOwnerIdentity) => Promise<void>) { handoff = handler; },
    async open(nativeSessionId, openOptions) {
      const owner = owners.get(nativeSessionId);
      if (owner) {
        if (openOptions?.takeOver === undefined) throw new NativeSessionOwnerError('native_session_owned', 'A terminal holds this session.', owner);
        if (openOptions.takeOver !== owner.generation) throw new NativeSessionOwnerError('native_owner_changed', 'The owner changed.', owner);
        owners.delete(nativeSessionId);
      }
      give(nativeSessionId, openOptions?.extensions);
      return open(nativeSessionId);
    },
    async close() { await Promise.all([...live.values()].map(session => session.dispose())); },
  } as AgentHostDirectory;
  const registration: AgentHostProviderRegistration = { adapter, directory };
  return {
    registration, providerId,
    /** The running session of this provider, once something has opened it. */
    session: (nativeSessionId: string) => live.get(nativeSessionId),
    known: () => [...known.keys()],
    /** The instructions and tools the Controller gave a session, once it opened or was created with them. */
    given: (nativeSessionId: string) => given.get(nativeSessionId),
    /** Calls one of a session's tools as its model would, and reads the answer. */
    async useTool(nativeSessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
      const tool = given.get(nativeSessionId)?.tools.find(item => item.name === name);
      if (!tool) throw new Error(`Session ${nativeSessionId} has no tool ${name}.`);
      return JSON.parse(await tool.execute(args) as string);
    },
    /** The working directory the page chose for a session it created, by native session id. */
    startedIn: (nativeSessionId: string) => startedIn.get(nativeSessionId),
    /** The Host loses the session, as a deleted or never saved native session is lost: the directory no longer lists it and opening it is refused. */
    forget(nativeSessionId: string) { known.delete(nativeSessionId); },
    /** Rows a terminal appends to the native history while the Controller's session does not see them; the provider reports the divergence. */
    terminalWrite(nativeSessionId: string, ...rows: ScriptedRow[]) {
      const saved = known.get(nativeSessionId);
      if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
      saved.history.push(...rows); saved.updatedAt = new Date().toISOString(); saved.diverged = true;
    },
    /** A terminal takes the session: the Controller records the owner and lets the session go. */
    /** The owner's generation is a UUID, as the Controller's own owner records are: the Relay and the take-over request accept no other shape. */
    async terminalTakes(nativeSessionId: string, generation: string = randomUUID()) {
      const owner: NativeOwnerIdentity = { kind: 'native_cli', generation };
      owners.set(nativeSessionId, owner);
      await handoff!(nativeSessionId, owner);
    },
    /** A session whose history is a copy of another's, as `claude --fork-session` in a terminal makes one. */
    fork(sourceId: string, nativeSessionId: string, title: string) {
      const source = known.get(sourceId);
      if (!source) throw new Error(`No scripted session ${sourceId}.`);
      known.set(nativeSessionId, { title, history: [...source.history], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), diverged: false });
    },
    /** What the native history holds now; the next reopen reads this. */
    replaceHistory(nativeSessionId: string, history: HistoryEntry[]) {
      const saved = known.get(nativeSessionId);
      if (!saved) throw new Error(`No scripted session ${nativeSessionId}.`);
      saved.history = [...history]; saved.updatedAt = new Date().toISOString();
    },
    /** Holds every send before the provider echoes it; the returned function lets them through. */
    hold(): () => void {
      let release!: () => void;
      held = new Promise<void>(resolve => { release = resolve; });
      return () => { release(); held = undefined; };
    },
  };
}
