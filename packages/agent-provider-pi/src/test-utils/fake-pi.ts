import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from '../native.js';
import type { PiChannel, PiExit, PiLaunch, PiLauncher } from '../process.js';
import { parsePiSession } from '../session-file.js';

/**
 * A fake of the pi CLI behind the adapter's native port (`PiLauncher`): it answers the RPC commands the adapter sends and plays scripted
 * runs with the event shapes and session file entries a real pi 0.73.1 produces (recorded from the CLI in `tests/native-assumptions.local.test.ts`).
 * One run is both the events a live session sees and the entries a reread finds, so a test can hold them against each other.
 */
export interface ToolStep { id: string; name: string; args: Json; output: string; isError?: boolean; exitCode?: number }
export interface MessageStep { thinking?: string; text?: string; tools?: ToolStep[]; stopReason?: 'stop' | 'error' | 'aborted'; errorMessage?: string }
export interface RunScript { prompt?: string; messages: MessageStep[] }

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
export class FakeClock { constructor(private now = 1_795_000_000_000) {} next(): number { return ++this.now; } }

export const userMessage = (text: string, timestamp: number): Json => ({ role: 'user', content: [{ type: 'text', text }], timestamp });
function assistantMessage(step: MessageStep, timestamp: number): Json {
  const content: Json[] = [];
  if (step.thinking) content.push({ type: 'thinking', thinking: step.thinking });
  if (step.text) content.push({ type: 'text', text: step.text });
  for (const tool of step.tools ?? []) content.push({ type: 'toolCall', id: tool.id, name: tool.name, arguments: tool.args });
  const stopReason = step.stopReason ?? (step.tools?.length ? 'toolUse' : 'stop');
  return { role: 'assistant', content, api: 'openai-completions', provider: 'fixture', model: 'm1', usage, stopReason, ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}), timestamp };
}
const toolResultMessage = (tool: ToolStep, timestamp: number): Json => ({ role: 'toolResult', toolCallId: tool.id, toolName: tool.name, content: [{ type: 'text', text: tool.output }], isError: tool.isError === true, timestamp });

/** The RPC events of a run and the messages it leaves in the session file. */
export function playRun(script: RunScript, clock: FakeClock, options: { steering?: string[] } = {}): { events: Json[]; messages: Json[] } {
  const events: Json[] = [{ type: 'agent_start' }, { type: 'turn_start' }];
  const messages: Json[] = [];
  if (script.prompt !== undefined) {
    const prompt = userMessage(script.prompt, clock.next());
    events.push({ type: 'message_start', message: prompt }, { type: 'message_end', message: prompt }); messages.push(prompt);
  }
  script.messages.forEach((step, index) => {
    const timestamp = clock.next();
    const final = assistantMessage(step, timestamp);
    const partial = (content: Json[]) => ({ ...final, content });
    events.push({ type: 'message_start', message: partial([]) });
    const done: Json[] = [];
    (final.content as Json[]).forEach((block, contentIndex) => {
      if (block.type === 'thinking' || block.type === 'text') {
        const key = block.type === 'thinking' ? 'thinking' : 'text', text = String(block[key]), cut = Math.ceil(text.length / 2);
        const kind = block.type === 'thinking' ? 'thinking' : 'text';
        events.push({ type: 'message_update', message: partial([...done]), assistantMessageEvent: { type: `${kind}_start`, contentIndex } });
        for (const delta of [text.slice(0, cut), text.slice(cut)].filter(Boolean)) events.push({ type: 'message_update', message: partial([...done]), assistantMessageEvent: { type: `${kind}_delta`, contentIndex, delta } });
        events.push({ type: 'message_update', message: partial([...done, block]), assistantMessageEvent: { type: `${kind}_end`, contentIndex, content: text } });
      } else events.push({ type: 'message_update', message: partial([...done, block]), assistantMessageEvent: { type: 'toolcall_end', contentIndex, toolCall: block } });
      done.push(block);
    });
    events.push({ type: 'message_end', message: final }); messages.push(final);
    const results: Json[] = [];
    for (const tool of step.tools ?? []) {
      events.push({ type: 'tool_execution_start', toolCallId: tool.id, toolName: tool.name, args: tool.args });
      events.push({ type: 'tool_execution_update', toolCallId: tool.id, toolName: tool.name, args: tool.args, partialResult: { content: [{ type: 'text', text: tool.output }], details: {} } });
      events.push({ type: 'tool_execution_end', toolCallId: tool.id, toolName: tool.name, result: { content: [{ type: 'text', text: tool.output }], details: tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {} }, isError: tool.isError === true });
      const result = toolResultMessage(tool, clock.next());
      events.push({ type: 'message_start', message: result }, { type: 'message_end', message: result }); messages.push(result); results.push(result);
    }
    events.push({ type: 'turn_end', message: final, toolResults: results });
    if (index < script.messages.length - 1) events.push({ type: 'turn_start' });
  });
  events.push({ type: 'agent_end', messages });
  void options;
  return { events, messages };
}

/** One entry per message, chained by parent as pi writes them. */
export function sessionLines(id: string, cwd: string, messages: readonly Json[], options: { model?: string } = {}): string[] {
  const lines: Json[] = [{ type: 'session', version: 3, id, timestamp: new Date(1_795_000_000_000).toISOString(), cwd }];
  let parent: string | null = null;
  const add = (entry: Json) => { const entryId = randomUUID().slice(0, 8); lines.push({ ...entry, id: entryId, parentId: parent, timestamp: new Date(1_795_000_000_000).toISOString() }); parent = entryId; };
  add({ type: 'model_change', provider: 'fixture', modelId: options.model ?? 'm1' });
  add({ type: 'thinking_level_change', thinkingLevel: 'off' });
  for (const message of messages) add({ type: 'message', message });
  return lines.map(line => JSON.stringify(line));
}

export interface FakeModel { provider: string; id: string; name: string; reasoning: boolean }
const MODELS: FakeModel[] = [{ provider: 'fixture', id: 'm1', name: 'M1', reasoning: false }, { provider: 'fixture', id: 'm2', name: 'M2', reasoning: true }];

export class FakeProcess implements PiChannel {
  private messageListeners: Array<(message: Json) => void> = [];
  private exitListeners: Array<(exit: PiExit) => void> = [];
  exited: PiExit | undefined;
  readonly commands: Json[] = [];
  streaming = false;
  model: FakeModel = MODELS[0]!;
  thinkingLevel = 'off';
  readonly uiAnswers = new Map<string, Json>();
  constructor(readonly fake: FakePi, readonly launch: PiLaunch, readonly sessionId: string, readonly sessionFile: string, private messages: Json[]) {}

  onMessage(listener: (message: Json) => void): void { this.messageListeners.push(listener); }
  onExit(listener: (exit: PiExit) => void): void { if (this.exited) listener(this.exited); else this.exitListeners.push(listener); }
  emit(message: Json): void { for (const listener of this.messageListeners) listener(message); }
  exit(code: number | null = 1, stderr = ''): void {
    if (this.exited) return;
    this.exited = { code, signal: null, stderr };
    for (const listener of this.exitListeners) listener(this.exited);
  }
  stop(): Promise<void> { this.exit(0); return Promise.resolve(); }

  send(command: Json): void {
    if (this.exited) throw new Error('The pi process has ended.');
    if (command.type === 'extension_ui_response') { this.uiAnswers.set(String(command.id), command); this.fake.uiAnswered(this, command); return; }
    this.commands.push(command);
    queueMicrotask(() => this.handle(command));
  }
  private respond(command: Json, data?: Json, error?: string): void {
    this.emit({ id: command.id, type: 'response', command: command.type, success: error === undefined, ...(error !== undefined ? { error } : data !== undefined ? { data } : {}) });
  }
  private state(): Json {
    return { model: { ...this.model, api: 'openai-completions' }, thinkingLevel: this.thinkingLevel, isStreaming: this.streaming, isCompacting: false, steeringMode: 'one-at-a-time', followUpMode: 'one-at-a-time',
      sessionFile: this.sessionFile, sessionId: this.sessionId, autoCompactionEnabled: true, messageCount: this.messages.length, pendingMessageCount: 0 };
  }
  private handle(command: Json): void {
    if (this.exited) return;
    const hook = this.fake.hooks[String(command.type)];
    if (hook?.(command, this)) return;
    switch (command.type) {
      case 'get_state': return this.respond(command, this.state());
      case 'get_available_models': return this.respond(command, { models: this.fake.models });
      case 'set_model': {
        const model = this.fake.models.find(entry => entry.provider === command.provider && entry.id === command.modelId);
        if (!model) return this.respond(command, undefined, `Model not found: ${String(command.provider)}/${String(command.modelId)}`);
        this.model = model; return this.respond(command, model as unknown as Json);
      }
      case 'set_thinking_level': this.thinkingLevel = String(command.level); return this.respond(command);
      case 'get_commands': return this.respond(command, { commands: this.fake.commands });
      case 'get_session_stats': return this.respond(command, { sessionFile: this.sessionFile, sessionId: this.sessionId, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 }, cost: 0.01, contextUsage: { tokens: 1000, contextWindow: 100000, percent: 1 } });
      case 'set_session_name': this.fake.renamed.push(String(command.name)); return this.respond(command);
      case 'abort': this.fake.aborted++; this.respond(command); return this.fake.onAbort(this);
      case 'prompt': return this.fake.onPrompt(this, command);
      default: return this.respond(command, undefined, `Unknown command: ${String(command.type)}`);
    }
  }
  /** Plays a run now: its events, then (as pi does with the first answer) the session file. */
  play(script: RunScript): Promise<void> {
    const { events, messages } = playRun(script, this.fake.clock);
    this.messages.push(...messages);
    this.streaming = true;
    return new Promise(resolve => {
      const step = (index: number) => {
        if (this.exited) return resolve();
        const event = events[index];
        if (!event) { this.streaming = false; this.fake.save(this); return resolve(); }
        this.emit(event);
        if (event.type === 'agent_end') { this.streaming = false; this.fake.save(this); return resolve(); }
        setImmediate(() => step(index + 1));
      };
      step(0);
    });
  }
  /** What the process holds of the conversation, for `get_messages` and the session file. */
  get conversation(): Json[] { return this.messages; }
}

export class FakePi {
  readonly clock = new FakeClock();
  readonly launches: PiLaunch[] = [];
  readonly processes: FakeProcess[] = [];
  readonly renamed: string[] = [];
  readonly commands: Json[] = [{ name: 'fix-tests', description: 'Fix failing tests', source: 'prompt' }, { name: 'skill:search', description: 'Search the web', source: 'skill' }];
  models: FakeModel[] = MODELS;
  aborted = 0;
  /** Replaces the handling of a command: return true when the hook answered it. */
  readonly hooks: Record<string, (command: Json, process: FakeProcess) => boolean> = {};
  private readonly scripts: RunScript[] = [];
  /** Called when a process receives an answer to an extension UI request. */
  uiAnswered: (process: FakeProcess, answer: Json) => void = () => {};
  /** Called when the adapter aborts: by default a running run ends as aborted. */
  onAbort: (process: FakeProcess) => void = () => {};
  constructor(readonly agentDirectory: string) {}

  /** The next prompt plays this run. */
  script(run: RunScript): this { this.scripts.push(run); return this; }
  readonly launcher: PiLauncher = launch => {
    this.launches.push(launch);
    const session = launch.args.indexOf('--session');
    let id: string, file: string, messages: Json[] = [];
    if (session >= 0) {
      file = launch.args[session + 1]!;
      const parsed = existsSync(file) ? parsePiSession(readFileSync(file, 'utf8')) : undefined;
      id = parsed?.header.id ?? randomUUID();
      messages = (parsed?.entries ?? []).flatMap(entry => entry.type === 'message' ? [entry.message as Json] : []);
    } else {
      id = randomUUID();
      file = join(this.agentDirectory, 'sessions', `--${launch.cwd.replace(/\//g, '-')}--`, `2026-11-26T00-00-00-000Z_${id}.jsonl`);
    }
    const process = new FakeProcess(this, launch, id, file, messages);
    this.processes.push(process);
    return process;
  };
  onPrompt(process: FakeProcess, command: Json): void {
    process.emit({ id: command.id, type: 'response', command: 'prompt', success: true });
    if (process.streaming) { this.steered.push(String(command.message)); return; }
    const script = this.scripts.shift() ?? { prompt: String(command.message), messages: [{ text: 'ok' }] };
    void process.play({ prompt: script.prompt ?? String(command.message), messages: script.messages });
  }
  readonly steered: string[] = [];
  save(process: FakeProcess): void {
    mkdirSync(join(process.sessionFile, '..'), { recursive: true });
    writeFileSync(process.sessionFile, `${sessionLines(process.sessionId, process.launch.cwd, process.conversation).join('\n')}\n`);
  }
  get last(): FakeProcess { return this.processes.at(-1)!; }
}
