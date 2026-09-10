import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AgentReplicaState } from '../replica/types.js';
import { AgentSessionSettings, type SessionControlView } from './AgentSessionSettings.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions, ResourceBinding } from '@borgee/agent-remote-protocol';
import { AgentCommandDetails } from './AgentCommandDetails.js';
import { useAgentCommands } from './useAgentCommands.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';

export interface AgentComposerProps {
  state?: AgentReplicaState;
  sessionKey?: string;
  disabled?: boolean;
  draft?: string;
  onDraftChange?(text: string): void;
  onSendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  onCancel?(): Promise<void>;
  onSetSessionSetting?(id: string, value: string): Promise<void>;
  onListCommands?(): Promise<AgentCommand[]>;
  onExecuteCommand?(id: string, args: string): Promise<AgentCommandResult>;
  onInspectCommand?(command: AgentCommand): void;
  onRequestResource?(binding: ResourceBinding): Promise<void>;
}

interface Draft {
  text: string;
  selectedSkill?: AgentCommand;
  inspectedSkill?: AgentCommand;
  pending?: 'send' | 'queue' | 'cancel' | 'command';
  interruptedTurnId?: string;
  interruptPending?: boolean;
  commandInterrupted?: boolean;
  view?: SessionControlView;
  settingPending?: boolean;
  commandsOpen?: boolean;
  commandsDismissed?: boolean;
  commandIndex?: number;
  feedback?: { kind: 'success' | 'error'; message: string };
}

export function AgentComposer({ state, sessionKey, disabled = false, draft: controlledDraft, onDraftChange, onSendMessage, onCancel, onSetSessionSetting, onListCommands, onExecuteCommand, onInspectCommand, onRequestResource }: AgentComposerProps) {
  const drafts = useRef(new Map<string, Draft>());
  const agentId = sessionKey ?? state?.agent?.id ?? '';
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const mounted = useRef(true);
  const focusRequested = useRef<string>();
  const [, refresh] = useState(0);
  let draft = drafts.current.get(agentId);
  if (!draft) {
    draft = { text: '' };
    drafts.current.set(agentId, draft);
  }
  const currentDraft = draft;
  if (controlledDraft !== undefined) currentDraft.text = controlledDraft;
  function setText(value: string): void { currentDraft.text = value; onDraftChange?.(value); }
  const { text, pending, feedback } = currentDraft;
  const busy = Boolean(pending || currentDraft.settingPending || currentDraft.interruptPending);
  const isCommand = text.trimStart().startsWith('/');
  const capabilities = state?.agent?.capabilities;
  const ready = Boolean(state?.agent) && !disabled;
  const wantsCommands = !currentDraft.commandsDismissed && Boolean(isCommand || currentDraft.commandsOpen);
  const directory = useAgentCommands(agentId, ready && wantsCommands && capabilities?.commands === true, onListCommands);
  const commandQuery = isCommand ? text.trimStart().slice(1) : '';
  const commands = directory.commands.filter(({ name }) => name.startsWith(commandQuery));
  const showCommands = wantsCommands && !/\s/u.test(commandQuery);
  const commandIndex = Math.min(currentDraft.commandIndex ?? 0, Math.max(0, commands.length - 1));
  const activeTurnId = state?.agent?.activeTurn?.turnId;
  const nativeBusy = Boolean(activeTurnId) || state?.agent?.status === 'running' || state?.agent?.status === 'waiting';
  const canQueue = nativeBusy && capabilities?.queueMessage === true;
  const selectedSkill = currentDraft.selectedSkill;
  if (activeTurnId === undefined) currentDraft.interruptedTurnId = undefined;
  const interruptRequested = (activeTurnId !== undefined && currentDraft.interruptedTurnId === activeTurnId)
    || (pending === 'command' && currentDraft.commandInterrupted === true);
  const canInterrupt = ready && capabilities?.cancel === true && (activeTurnId !== undefined || pending === 'command')
    && state?.agent?.status !== 'failed' && state?.agent?.status !== 'closed' && !interruptRequested;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { composing.current = false; }, [agentId]);
  useLayoutEffect(() => {
    if (showCommands) inputRef.current?.parentElement?.querySelector(`#chat-command-${commandIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [commandIndex, showCommands]);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    if (focusRequested.current === agentId && !pending) {
      focusRequested.current = undefined;
      if (!input.closest('[hidden]')) input.focus({ preventScroll: true });
    }
  }, [agentId, text, pending]);

  function chooseCommand(command: AgentCommand): void {
    if (busy || !ready) return;
    if (command.kind === 'skill') {
      currentDraft.selectedSkill = command;
      if (isCommand) setText(currentDraft.text.trimStart().replace(/^\/[^\s]*[\t ]?/, ''));
      currentDraft.commandsOpen = false;
      currentDraft.commandsDismissed = true;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      inputRef.current?.focus();
      return;
    }
    if (command.inputHint && currentDraft.text.trim() !== `/${command.name}`) {
      setText(`/${command.name} `);
      currentDraft.commandsOpen = false;
      currentDraft.commandsDismissed = false;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      inputRef.current?.focus();
      return;
    }
    void executeCommand(command, '');
  }

  async function executeCommand(command: AgentCommand, args: string): Promise<void> {
    if (!onExecuteCommand || !ready || busy || currentDraft.pending) return;
    const submitted = currentDraft.text;
    const submittedSkill = currentDraft.selectedSkill;
    currentDraft.pending = 'command';
    currentDraft.commandInterrupted = false;
    currentDraft.commandsOpen = false;
    currentDraft.commandsDismissed = true;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      const result = await onExecuteCommand(command.id, args);
      if (submittedSkill?.id === command.id && currentDraft.selectedSkill === submittedSkill) currentDraft.selectedSkill = undefined;
      if (currentDraft.text === submitted && (isCommand || submittedSkill?.id === command.id)) {
        currentDraft.text = '';
        if (currentAgent.current === agentId) onDraftChange?.('');
      }
      if (result.text) currentDraft.feedback = { kind: 'success', message: result.text };
    } catch (error) {
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Native command failed.' };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  async function run(kind: 'send' | 'queue' | 'cancel'): Promise<void> {
    if (kind === 'cancel') {
      if (!onCancel || !canInterrupt || currentDraft.interruptPending) return;
      currentDraft.interruptPending = true;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      try {
        await onCancel();
        currentDraft.interruptedTurnId = activeTurnId;
        currentDraft.commandInterrupted = currentDraft.pending === 'command';
        currentDraft.feedback = { kind: 'success', message: 'Cancellation requested.' };
      } catch (error) {
        currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Interrupt failed.' };
      } finally {
        currentDraft.interruptPending = false;
        if (mounted.current) refresh((value) => value + 1);
      }
      return;
    }
    if (currentDraft.selectedSkill && !showCommands) {
      if (kind !== 'send' || nativeBusy || !ready || busy) return;
      await executeCommand(currentDraft.selectedSkill, currentDraft.text);
      return;
    }
    if (isCommand) {
      if (!ready || busy) return;
      const match = /^\/([^\s]+)([\s\S]*)$/u.exec(currentDraft.text.trimStart());
      const command = directory.commands.find(({ name }) => name === match?.[1]);
      if (directory.status === 'loading' && capabilities?.commands) return;
      if (kind === 'send' && command?.kind === 'skill') chooseCommand(command);
      else if (kind === 'send' && command) await executeCommand(command, match?.[2] ?? '');
      else {
        currentDraft.feedback = { kind: 'error', message: directory.error ?? 'Unknown or unavailable native command. Open / to refresh the command list.' };
        refresh((value) => value + 1);
      }
      return;
    }
    const action = onSendMessage;
    if (!action || currentDraft.pending || currentDraft.settingPending || !ready || !currentDraft.text.trim()) return;
    if (!capabilities?.sendMessage || (kind === 'queue' && !canQueue)) return;
    const submitted = currentDraft.text;
    currentDraft.pending = kind;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      if (kind === 'queue') await action(submitted.trim(), { delivery: 'next_turn' });
      else await action(submitted.trim());
      if (currentDraft.text === submitted) setText('');
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? 'Message sent.' : 'Message queued by Provider.' };
      if (currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Agent command failed.' };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current) return;
    if (showCommands && event.key === 'Escape') {
      event.preventDefault();
      currentDraft.commandsDismissed = true;
      currentDraft.commandsOpen = false;
      refresh((value) => value + 1);
      return;
    }
    if (showCommands && !busy && commands.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        currentDraft.commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length;
        refresh((value) => value + 1);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        chooseCommand(commands[commandIndex]!);
        return;
      }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void run('send');
  }

  return <section className="agent-composer" aria-label="Live provider controls" aria-busy={busy}>
    {state?.agent ? <AgentSessionSettings key={agentId} state={state} disabled={disabled} view={currentDraft.view} busy={busy}
      onView={(view) => { currentDraft.view = view; refresh((value) => value + 1); }}
      onPendingChange={(value) => { currentDraft.settingPending = value; if (mounted.current) refresh((count) => count + 1); }}
      onSelect={onSetSessionSetting} /> : null}
    {state?.agent ? <AgentActivityStatus state={state} disabled={disabled}
      commandPending={pending === 'command'}
      interruptDisabled={!canInterrupt || currentDraft.interruptPending === true || (pending !== undefined && pending !== 'command') || !onCancel}
      interruptLabel={currentDraft.interruptPending ? 'Interrupting…' : interruptRequested ? 'Interrupt requested' : 'Interrupt'}
      onInterrupt={() => void run('cancel')} /> : null}
    <div className="agent-composer-input">
    {showCommands ? <div className="agent-command-menu">
      {capabilities?.commands !== true ? <p>This Provider does not expose native commands.</p>
        : directory.status === 'loading' ? <p role="status">Loading native commands…</p>
        : directory.status === 'failed' ? <><p role="alert">{directory.error}</p><button type="button" data-testid="retry-commands" onClick={directory.retry}>Retry</button></>
        : commands.length === 0 ? <p>No matching native commands.</p>
        : <div role="listbox" id="chat-commands" aria-label="Native commands">{commands.map((command, index) => <button
          type="button" role="option" aria-selected={index === commandIndex} id={`chat-command-${index}`} key={command.id}
          onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command)}>
          <strong>/{command.name}</strong><span className="agent-command-description" title={command.description}>{command.shortDescription || command.description}</span>
          {command.kind !== 'command' ? <small className="agent-command-kind">{command.kind === 'skill' ? 'Skill' : 'Prompt'}</small> : null}
        </button>)}</div>}
    </div> : null}
    {selectedSkill ? <div className="agent-composer-attachments" aria-label="Selected skill">
      <span className="agent-skill-tag">
        <button type="button" aria-label={`View skill ${selectedSkill.name}`} onClick={() => {
          if (onInspectCommand) onInspectCommand(selectedSkill);
          else { currentDraft.inspectedSkill = selectedSkill; refresh((value) => value + 1); }
        }}><span aria-hidden="true">⌘</span> <span>{selectedSkill.name}</span></button>
        <button type="button" aria-label={`Remove skill ${selectedSkill.name}`} disabled={busy} onClick={() => { currentDraft.selectedSkill = undefined; refresh((value) => value + 1); inputRef.current?.focus(); }}>×</button>
      </span>
      {nativeBusy ? <span className="agent-composer-note">This Provider can invoke skills when the current turn finishes.</span> : null}
    </div> : null}
    <label htmlFor="prompt-input" className="agent-visually-hidden">Message</label>
    <textarea
      ref={inputRef}
      id="prompt-input"
      data-testid="prompt-input"
      rows={2}
      value={text}
      onChange={(event) => { setText(event.target.value); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; refresh((value) => value + 1); }}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      disabled={!ready || busy}
      placeholder={ready ? 'Message the Agent…' : 'Open or attach to an Agent first.'}
      aria-describedby="composer-hint"
      aria-controls={showCommands && commands.length > 0 ? 'chat-commands' : undefined}
      aria-activedescendant={showCommands && commands.length > 0 ? `chat-command-${commandIndex}` : undefined}
    />
    </div>
    <div className="agent-composer-actions">
      <p id="composer-hint" className="agent-composer-note">{nativeBusy ? 'Enter to send now' : 'Enter to send'} · Shift+Enter for a new line · / for commands</p>
      <div className="agent-composer-secondary-controls">
        <button type="button" aria-label="Open chat commands" disabled={!ready || busy} onClick={() => { currentDraft.commandsOpen = !currentDraft.commandsOpen; currentDraft.commandsDismissed = false; refresh((value) => value + 1); inputRef.current?.focus(); }}>/</button>
        {canQueue ? <button type="button" data-testid="queue-submit" disabled={!ready || !capabilities?.sendMessage || !text.trim() || isCommand || Boolean(selectedSkill) || busy || !onSendMessage} title="Let the native Provider handle this after the current turn" onClick={() => void run('queue')}>{pending === 'queue' ? 'Queueing…' : 'Queue for next turn'}</button> : null}
      </div>
      <button type="button" data-testid="prompt-submit" title={nativeBusy ? 'Send input to the active native turn' : 'Start a new native turn'} disabled={!ready || busy || (selectedSkill ? nativeBusy || !onExecuteCommand : !text.trim() || (!isCommand && (capabilities?.sendMessage !== true || !onSendMessage)))} onClick={() => void run('send')}>{pending === 'send' ? 'Sending…' : 'Send message'}</button>
    </div>
    {!ready ? <p className="agent-composer-note">Open or attach to an Agent first.</p> : null}
    {feedback ? <p className="agent-composer-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
    {!onInspectCommand && currentDraft.inspectedSkill && state ? <AgentCommandDetails key={`${agentId}:${currentDraft.inspectedSkill.id}`}
      command={currentDraft.inspectedSkill} resources={state.resources} onRequestResource={onRequestResource}
      onClose={() => { currentDraft.inspectedSkill = undefined; refresh((value) => value + 1); }} /> : null}
  </section>;
}
