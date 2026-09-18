import type { ResourceResponseState } from '@agent-remote-controller/agent-remote-protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentReplicaState } from '../replica/types.js';
import { AgentSessionSettings, type SessionControlView } from './AgentSessionSettings.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions, ResourceBinding } from '@agent-remote-controller/agent-remote-protocol';
import { AgentCommandDetails } from './AgentCommandDetails.js';
import { useAgentCommands } from './useAgentCommands.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';

export interface AgentComposerProps {
  state?: AgentReplicaState;
  sessionControls?: ReactNode;
  attachments?: ReactNode;
  consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[];
  onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>;
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
  onRequestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  onResolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
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
  feedback?: { kind: 'success' | 'error'; message: string; delivery?: boolean };
}

export function AgentComposer({ state, sessionControls, sessionKey, disabled = false, draft: controlledDraft, onDraftChange, onSendMessage, onCancel, onSetSessionSetting, onListCommands, onExecuteCommand, onInspectCommand, onRequestResource, onResolveResource, attachments, consoleCommands = [], onExecuteConsoleCommand }: AgentComposerProps) {
  const controlId = `composer-${useId().replace(/:/gu, '')}`;
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
  const runtimeConnection = state?.agent?.runtimeInfo.connection;
  const runtimeUnavailable = runtimeConnectionMessage(runtimeConnection?.state);
  const ready = Boolean(state?.agent) && !disabled && runtimeUnavailable === undefined;
  const readOnly = capabilities?.sendMessage === false;
  const nativeCommandsEnabled = !readOnly && capabilities?.commands === true;
  const readOnlyHint = 'This session is read-only. Direct input is disabled.';
  const wantsCommands = !currentDraft.commandsDismissed && Boolean((!readOnly && isCommand) || currentDraft.commandsOpen);
  const directory = useAgentCommands(agentId, ready && wantsCommands && nativeCommandsEnabled, onListCommands);
  const commandQuery = !readOnly && isCommand ? text.trimStart().slice(1) : '';
  const availableCommands = [...consoleCommands, ...(readOnly ? [] : directory.commands).filter((command) => !consoleCommands.some((local) => local.name === command.name || local.aliases?.includes(command.name)))];
  const commands = availableCommands.filter((command) => command.name.startsWith(commandQuery) || (commandQuery && consoleCommands.find((local) => local.id === command.id)?.aliases?.some((alias) => alias.startsWith(commandQuery))));
  const showCommands = wantsCommands && (!readOnly || consoleCommands.length > 0) && !/\s/u.test(commandQuery);
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
    if (showCommands) inputRef.current?.parentElement?.querySelector(`#${controlId}-command-${commandIndex}`)?.scrollIntoView?.({ block: 'nearest' });
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
    if (busy || !ready || (readOnly && !consoleCommands.some((local) => local.id === command.id))) return;
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
    const localCommand = consoleCommands.some((local) => local.id === command.id);
    if (readOnly && !localCommand) return;
    const execute = localCommand ? onExecuteConsoleCommand : onExecuteCommand;
    if (!execute || !ready || busy || currentDraft.pending) return;
    const submitted = currentDraft.text;
    const submittedSkill = currentDraft.selectedSkill;
    currentDraft.pending = 'command';
    currentDraft.commandInterrupted = false;
    currentDraft.commandsOpen = false;
    currentDraft.commandsDismissed = true;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      const result = await execute(command.id, args);
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
    if (readOnly) return;
    if (currentDraft.selectedSkill && !showCommands) {
      if (kind !== 'send' || nativeBusy || !ready || busy) return;
      await executeCommand(currentDraft.selectedSkill, currentDraft.text);
      return;
    }
    if (isCommand) {
      if (!ready || busy) return;
      const match = /^\/([^\s]+)([\s\S]*)$/u.exec(currentDraft.text.trimStart());
      const command = consoleCommands.find((local) => local.name === match?.[1] || local.aliases?.includes(match?.[1] ?? '')) ?? directory.commands.find(({ name }) => name === match?.[1]);
      if (!command && directory.status === 'loading' && nativeCommandsEnabled) return;
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
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? 'Message sent.' : 'Message queued by Provider.', delivery: true };
      if (currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Agent command failed.' };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (readOnly) return;
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
    <div className="agent-composer-input">
    {showCommands ? <div className="agent-command-menu">
      {directory.status === 'loading' && nativeCommandsEnabled ? <p role="status">Loading native commands…</p> : null}
      {directory.status === 'failed' && nativeCommandsEnabled ? <><p role="alert">{directory.error}</p><button type="button" data-testid="retry-commands" onClick={directory.retry}>Retry</button></> : null}
      {commands.length === 0 ? <p>{capabilities?.commands !== true ? 'This Provider does not expose native commands.' : 'No matching native commands.'}</p>
        : <div role="listbox" id={`${controlId}-commands`} aria-label="Native commands">{commands.map((command, index) => <button
          type="button" role="option" aria-selected={index === commandIndex} id={`${controlId}-command-${index}`} key={command.id}
          onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command)}>
          <strong>/{command.name}</strong><span className="agent-command-description" title={command.description}>{command.shortDescription || command.description}</span>
          {consoleCommands.some((local) => local.id === command.id) ? <small className="agent-command-kind">Console</small>
            : command.kind !== 'command' ? <small className="agent-command-kind">{command.kind === 'skill' ? 'Skill' : 'Prompt'}</small> : null}
        </button>)}</div>}
    </div> : null}
    {attachments}
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
    <label htmlFor={`${controlId}-input`} className="agent-visually-hidden">Message</label>
    <textarea
      ref={inputRef}
      id={`${controlId}-input`}
      data-testid="prompt-input"
      rows={1}
      value={text}
      onChange={(event) => { setText(event.target.value); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; refresh((value) => value + 1); }}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      disabled={!ready || readOnly || busy}
      placeholder={readOnly ? readOnlyHint : runtimeUnavailable ?? (ready ? 'Message the Agent…' : 'Open or attach to an Agent first.')}
      aria-describedby={`${controlId}-hint`}
      aria-controls={showCommands && commands.length > 0 ? `${controlId}-commands` : undefined}
      aria-activedescendant={showCommands && commands.length > 0 ? `${controlId}-command-${commandIndex}` : undefined}
    />
    </div>
    <p id={`${controlId}-hint`} className={`agent-composer-note${readOnly ? '' : ' agent-visually-hidden'}`}>{readOnly ? readOnlyHint : <>{nativeBusy ? 'Enter to send now' : 'Enter to send'} · Shift+Enter for a new line · / for commands</>}</p>
    <div className="agent-composer-actions">
      <div className="agent-composer-secondary-controls">
        <button type="button" aria-label="Open chat commands" disabled={!ready || busy || (readOnly && consoleCommands.length === 0)} onClick={() => { currentDraft.commandsOpen = !currentDraft.commandsOpen; currentDraft.commandsDismissed = false; refresh((value) => value + 1); inputRef.current?.focus(); }}>/</button>
        {canQueue ? <button type="button" data-testid="queue-submit" aria-label={pending === 'queue' ? 'Queueing…' : 'Queue for next turn'} disabled={!ready || !capabilities?.sendMessage || !text.trim() || isCommand || Boolean(selectedSkill) || busy || !onSendMessage} title="Let the native Provider handle this after the current turn" onClick={() => void run('queue')}>{pending === 'queue' ? 'Queueing…' : 'Queue'}</button> : null}
      </div>
      {state?.agent ? <AgentSessionSettings key={agentId} state={state} disabled={disabled} view={currentDraft.view} busy={busy}
        onView={(view) => { currentDraft.view = view; refresh((value) => value + 1); }}
        onPendingChange={(value) => { currentDraft.settingPending = value; if (mounted.current) refresh((count) => count + 1); }}
        onSelect={onSetSessionSetting}>{sessionControls}</AgentSessionSettings> : null}
      {state?.agent ? <AgentActivityStatus state={state} disabled={disabled}
        commandPending={pending === 'command'}
        interruptDisabled={!canInterrupt || currentDraft.interruptPending === true || (pending !== undefined && pending !== 'command') || !onCancel}
        interruptLabel={currentDraft.interruptPending ? 'Interrupting…' : interruptRequested ? 'Interrupt requested' : 'Interrupt'}
        onInterrupt={() => void run('cancel')} /> : null}
      <button type="button" data-testid="prompt-submit" aria-label={pending === 'send' ? 'Sending…' : 'Send message'} title={nativeBusy ? 'Send input to the active native turn' : 'Start a new native turn'} disabled={!ready || readOnly || busy || (selectedSkill ? nativeBusy || !onExecuteCommand : !text.trim() || (!isCommand && (capabilities?.sendMessage !== true || !onSendMessage)))} onClick={() => void run('send')}><span aria-hidden="true">{pending === 'send' ? '…' : '↑'}</span></button>
    </div>
    {runtimeUnavailable ? <p className="agent-composer-note" role="status">{runtimeUnavailable}</p>
      : !ready ? <p className="agent-composer-note">Open or attach to an Agent first.</p> : null}
    {feedback && !(feedback.delivery && state?.outgoingMessages !== undefined) ? <p className="agent-composer-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
    {!onInspectCommand && currentDraft.inspectedSkill && state ? <AgentCommandDetails key={`${agentId}:${currentDraft.inspectedSkill.id}`}
      command={currentDraft.inspectedSkill} resources={state.resources} onRequestResource={onRequestResource}
      onResolveResource={onResolveResource} resourceScopeKey={JSON.stringify([agentId, state.timeline.epoch, currentDraft.inspectedSkill.id])}
      onClose={() => { currentDraft.inspectedSkill = undefined; refresh((value) => value + 1); }} /> : null}
  </section>;
}

function runtimeConnectionMessage(state?: 'connected' | 'reconnecting' | 'restoring' | 'unavailable'): string | undefined {
  if (state === 'reconnecting') return 'Native runtime is reconnecting. Your draft is preserved.';
  if (state === 'restoring') return 'Native runtime is restoring this session. Your draft is preserved.';
  if (state === 'unavailable') return 'Native runtime is unavailable. Your draft is preserved.';
  return undefined;
}
