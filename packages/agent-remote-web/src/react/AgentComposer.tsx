import { remoteSessionState, type RemoteSessionState } from '../client/session-state.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { AgentReplicaState } from '../replica/types.js';
import { AgentSessionSettings, type SessionControlView } from './AgentSessionSettings.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { AgentCommandDetails } from './AgentCommandDetails.js';
import { useAgentCommands } from './useAgentCommands.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor.js';
import { ImageUploadStatus } from './ImageUploadStatus.js';
import { useImageDraft, type UploadImage } from './useImageDraft.js';
import { draftHasContent, snapshotContent } from './composer-document.js';
import type { MessagePart } from '@orchardworks/agent-remote-protocol';
import { useSendButtonPress } from './useSendButtonPress.js';
import { usePendingSend } from './usePendingSend.js';
import { PendingSendQueue } from './PendingSendQueue.js';

export interface AgentComposerProps {
  sessionState?: RemoteSessionState;
  compact?: boolean;
  /** Prevent editing while preserving capabilities and the current draft. */
  readOnly?: boolean;
  readOnlyLabel?: string;
  readOnlyNotice?: ReactNode;
  /** Retain ownership controls while hiding the preserved draft. */
  readOnlyCollapsed?: boolean;
  state?: AgentReplicaState;
  sessionControls?: ReactNode;
  renderSessionSettingError?(error: unknown): ReactNode;
  attachments?: ReactNode;
  consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[];
  onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>;
  sessionKey?: string;
  disabled?: boolean;
  /** Describes the current connection or synchronization stage while disabled. */
  disabledLabel?: string;
  /** Accept unsent messages while a disconnected session is recovering. */
  recovering?: boolean;
  visible?: boolean;
  activityVisible?: boolean;
  draftScope?: string;
  onUploadImage?: UploadImage;
  onSendMessageContent?(content: readonly MessagePart[], options?: AgentMessageOptions & { imageDigests?: Readonly<Record<string, string>> }): Promise<void>;
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

export function AgentComposer({ sessionState: suppliedSessionState, readOnly: forcedReadOnly = false, readOnlyLabel, readOnlyNotice, readOnlyCollapsed = false, compact = false, state, sessionControls, renderSessionSettingError, sessionKey, disabled = false, disabledLabel, recovering = false, draft: controlledDraft, onDraftChange, onSendMessage, onCancel, onSetSessionSetting, onListCommands, onExecuteCommand, onInspectCommand, onRequestResource, onResolveResource, attachments, consoleCommands = [], onExecuteConsoleCommand, visible = true, activityVisible = visible, draftScope, onUploadImage, onSendMessageContent }: AgentComposerProps) {
  const controlId = `composer-${useId().replace(/:/gu, '')}`;
  const drafts = useRef(new Map<string, Draft>());
  const agentId = sessionKey ?? state?.agent?.id ?? '';
  const waiting = usePendingSend(JSON.stringify([draftScope, agentId]), visible);
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerAgent = useRef<string>();
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
  function setText(value: string): void { currentDraft.text = value; if (richEnabled) imageDraft.setText(value); else onDraftChange?.(value); }
  function focusInput(): void { if (richEnabled) editorRef.current?.focus(); else inputRef.current?.focus(); }
  const { text, pending, feedback } = currentDraft;
  const operationBusy = Boolean(pending || currentDraft.settingPending || currentDraft.interruptPending);
  const busy = operationBusy;
  const session = suppliedSessionState ?? remoteSessionState(state, disabled ? 'connecting' : 'ready');
  const capabilities = state?.agent?.capabilities;
  const runtimeConnection = session.runtime;
  const runtimeUnavailable = runtimeConnectionMessage(runtimeConnection?.state);
  const controlChecking = session.controlChecking;
  const ready = session.synchronized && !disabled && !forcedReadOnly && !session.readOnly && !controlChecking && runtimeUnavailable === undefined;
  const readOnly = forcedReadOnly || session.readOnly || capabilities?.sendMessage === false;
  const terminal = state?.agent?.status === 'failed' || state?.agent?.status === 'closed';
  const canWait = (session.recovering || recovering || disabled || controlChecking || runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring') && Boolean(state?.agent) && !readOnly && !terminal && runtimeConnection?.state !== 'unavailable';
  const richEnabled = Boolean(capabilities?.imageInput);
  const imageDraft = useImageDraft({ scope: draftScope, sessionKey: agentId, text, enabled: richEnabled, active: visible && ready && !readOnly, upload: onUploadImage,
    onTextChange: value => { currentDraft.text = value; onDraftChange?.(value); refresh(count => count + 1); } });
  const hasImages = richEnabled && imageDraft.hasImages;
  const hasContent = richEnabled ? draftHasContent(imageDraft.parts) : Boolean(text.trim());
  const ownershipReadOnly = forcedReadOnly && Boolean(readOnlyNotice);
  const hideDraft = ownershipReadOnly && (readOnlyCollapsed || (!hasContent && !attachments && !currentDraft.selectedSkill));
  const imageSendReady = !hasImages || imageDraft.ready;
  const isCommand = !hasImages && text.trimStart().startsWith('/');
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
  const nativeBusy = session.busy;
  const canQueue = nativeBusy && capabilities?.queueMessage === true;
  const selectedSkill = currentDraft.selectedSkill;
  const canSubmit = (ready && (isCommand || selectedSkill ? session.operations.execute_command.allowed || consoleCommands.length > 0 : session.operations.send_message.allowed)) || (canWait && !isCommand && !selectedSkill);
  if (activeTurnId === undefined) currentDraft.interruptedTurnId = undefined;
  const interruptRequested = (activeTurnId !== undefined && currentDraft.interruptedTurnId === activeTurnId)
    || (pending === 'command' && currentDraft.commandInterrupted === true);
  const canInterrupt = ready && session.operations.cancel.allowed && (session.busy || pending === 'command')
    && state?.agent?.status !== 'failed' && state?.agent?.status !== 'closed' && !interruptRequested;

  const dispatchReady = ready && !readOnly && !terminal && !operationBusy && session.operations.send_message.allowed;
  const latest = useRef({ agentId, dispatchReady, onSendMessage, onSendMessageContent, onUploadImage });
  latest.current = { agentId, dispatchReady, onSendMessage, onSendMessageContent, onUploadImage };
  function deferMessage(): void {
    const submitted = currentDraft.text;
    const parts = imageDraft.parts.map(part => ({ ...part }));
    // Own the bytes independently of the editable draft and its upload lifecycle.
    const images = Object.fromEntries(parts.flatMap(part => part.type === 'image'
      ? [[part.imageId, { blob: imageDraft.images[part.imageId]?.blob, uploadId: crypto.randomUUID() }]] : []));
    const containsImages = hasImages;
    currentDraft.feedback = undefined;
    waiting.start({
      text: containsImages ? parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join('') : submitted,
      ready() {
        const current = latest.current;
        return current.agentId === agentId && current.dispatchReady && Boolean(containsImages ? current.onSendMessageContent && current.onUploadImage : current.onSendMessage);
      },
      async send(signal, dispatch) {
        signal.throwIfAborted();
        const upload = latest.current.onUploadImage!;
        const attachments: Record<string, Awaited<ReturnType<UploadImage>>> = {};
        for (const [id, image] of Object.entries(images)) {
          if (!image.blob) throw new Error('Local image bytes are missing. Copy the message and attach the image again.');
          attachments[id] = await upload(image.blob, image.uploadId, { signal });
          signal.throwIfAborted();
        }
        const content = containsImages ? snapshotContent(parts, attachments) : undefined;
        if (!dispatch()) return;
        if (content) await latest.current.onSendMessageContent!(content, {
          imageDigests: Object.fromEntries(Object.values(attachments).map(image => [image.attachmentId, image.sha256])),
        });
        else await latest.current.onSendMessage!(submitted.trim());
      },
    });
    setText('');
    focusInput();
    refresh(value => value + 1);
  }

  const sendButtonPress = useSendButtonPress(agentId, canSubmit && !readOnly && !busy, () => {
    if (richEnabled) { editorRef.current?.insertText('\n'); return; }
    const input = inputRef.current;
    if (!input || input.disabled || composing.current) return;
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    setText(input.value);
    currentDraft.commandIndex = 0;
    currentDraft.commandsDismissed = false;
    currentDraft.feedback = undefined;
    refresh(value => value + 1);
    input.focus({ preventScroll: true });
  }, () => void run('send'));

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useLayoutEffect(() => { composing.current = false; }, [agentId]);
  useLayoutEffect(() => {
    if (showCommands) inputRef.current?.parentElement?.querySelector(`#${controlId}-command-${commandIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [commandIndex, showCommands]);
  useLayoutEffect(() => {
    if (readOnly) focusRequested.current = undefined;
    const input = inputRef.current;
    if (!input) { if (focusRequested.current === agentId && !pending && visible) { focusRequested.current = undefined; editorRef.current?.focus(); } return; }
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    if (focusRequested.current === agentId && !pending) {
      focusRequested.current = undefined;
      if (!input.closest('[hidden]')) input.focus({ preventScroll: true });
    }
  }, [agentId, text, pending, readOnly, hideDraft]);

  function chooseCommand(command: AgentCommand): void {
    if (busy || !ready || (readOnly && !consoleCommands.some((local) => local.id === command.id))) return;
    if (command.kind === 'skill') {
      currentDraft.selectedSkill = command;
      if (isCommand) setText(currentDraft.text.trimStart().replace(/^\/[^\s]*[\t ]?/, ''));
      currentDraft.commandsOpen = false;
      currentDraft.commandsDismissed = true;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      focusInput();
      return;
    }
    if (command.inputHint && currentDraft.text.trim() !== `/${command.name}`) {
      setText(`/${command.name} `);
      currentDraft.commandsOpen = false;
      currentDraft.commandsDismissed = false;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      focusInput();
      return;
    }
    void executeCommand(command, '');
  }

  async function executeCommand(command: AgentCommand, args: string): Promise<void> {
    const localCommand = consoleCommands.some((local) => local.id === command.id);
    if (!localCommand && (readOnly || !session.operations.execute_command.allowed)) return;
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
        if (richEnabled) imageDraft.setText('');
        else { currentDraft.text = ''; if (currentAgent.current === agentId) onDraftChange?.(''); }
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
    if (hasImages && currentDraft.selectedSkill) { currentDraft.feedback = { kind: 'error', message: 'Remove the selected skill before sending images.' }; refresh(value => value + 1); return; }
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
    if (kind === 'send' && (!ready || waiting.items.length > 0) && (ready || canWait) && !operationBusy && hasContent && capabilities?.sendMessage && (hasImages ? onSendMessageContent : action)) { deferMessage(); return; }
    if ((hasImages ? !onSendMessageContent : !action) || currentDraft.pending || currentDraft.settingPending || !ready || !hasContent || !imageSendReady) return;
    if (!(kind === 'queue' ? session.operations.queue_message.allowed : session.operations.send_message.allowed) || (kind === 'queue' && (!canQueue || waiting.items.length > 0))) return;
    const submitted = currentDraft.text;
    const submittedParts = imageDraft.parts;
    const content = hasImages ? imageDraft.snapshot() : undefined;
    const imageDigests = content ? Object.fromEntries(Object.values(imageDraft.images).flatMap(image => image.attachment ? [[image.attachment.attachmentId, image.attachment.sha256]] : [])) : undefined;
    currentDraft.pending = kind;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      if (content) await onSendMessageContent!(content, { ...(kind === 'queue' ? { delivery: 'next_turn' as const } : {}), imageDigests });
      else if (kind === 'queue') await action!(submitted.trim(), { delivery: 'next_turn' });
      else await action!(submitted.trim());
      if (currentDraft.text === submitted && (!content || imageDraft.parts === submittedParts)) {
        if (richEnabled) imageDraft.setText(''); else { currentDraft.text = ''; if (currentAgent.current === agentId) onDraftChange?.(''); }
      }
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? 'Message sent.' : 'Message queued by Provider.', delivery: true };
      if (currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      if (content && error && typeof error === 'object' && 'code' in error && error.code === 'invalid_image_input') {
        imageDraft.rejectAttachments(content, 'The Host could not use this image. Retry the upload, replace it, or remove it.');
      }
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Agent command failed.' };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement> | globalThis.KeyboardEvent): void {
    if (readOnly) return;
    const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event;
    if (nativeEvent.isComposing || nativeEvent.keyCode === 229 || composing.current) return;
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

  return <section className="agent-composer" aria-label="Live provider controls" aria-busy={busy} data-control-readonly={ownershipReadOnly || undefined}>
    <PendingSendQueue items={waiting.items} onCancel={waiting.cancel} onRetry={waiting.retry} />
    <div className="agent-composer-input">
    {forcedReadOnly ? readOnlyNotice : null}
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
    <div className="agent-composer-draft" hidden={hideDraft}>
    {attachments}
    {selectedSkill ? <div className="agent-composer-attachments" aria-label="Selected skill">
      <span className="agent-skill-tag">
        <button type="button" aria-label={`View skill ${selectedSkill.name}`} onClick={() => {
          if (onInspectCommand) onInspectCommand(selectedSkill);
          else { currentDraft.inspectedSkill = selectedSkill; refresh((value) => value + 1); }
        }}><span aria-hidden="true">⌘</span> <span>{selectedSkill.name}</span></button>
        <button type="button" aria-label={`Remove skill ${selectedSkill.name}`} disabled={busy || readOnly} onClick={() => { currentDraft.selectedSkill = undefined; refresh((value) => value + 1); focusInput(); }}>×</button>
      </span>
      {nativeBusy ? <span className="agent-composer-note">This Provider can invoke skills when the current turn finishes.</span> : null}
    </div> : null}
    <label htmlFor={`${controlId}-input`} className="agent-visually-hidden">Message</label>
    {richEnabled ? <ComposerEditor key={agentId} ref={editorRef} id={`${controlId}-input`} parts={imageDraft.parts} images={imageDraft.images}
      disabled={!state?.agent || readOnly || busy} onChange={parts => { imageDraft.setParts(parts); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; }}
      onFiles={imageDraft.addFiles} onImport={imageDraft.importParts} onRetry={imageDraft.retry} onKeyDown={handleKeyDown}
      describedBy={`${controlId}-hint`} controls={showCommands && commands.length > 0 ? `${controlId}-commands` : undefined}
      activeDescendant={showCommands && commands.length > 0 ? `${controlId}-command-${commandIndex}` : undefined} /> : <textarea
      ref={inputRef}
      id={`${controlId}-input`}
      data-testid="prompt-input"
      rows={1}
      value={text}
      onChange={(event) => { setText(event.target.value); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; refresh((value) => value + 1); }}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      disabled={!ownershipReadOnly && (!state?.agent || readOnly || busy)}
      readOnly={ownershipReadOnly}
      placeholder={ownershipReadOnly ? '' : forcedReadOnly ? readOnlyLabel ?? 'This recording is read-only.' : readOnly ? readOnlyHint : state?.agent ? 'Message…' : 'Open or attach to an Agent first.'}
      aria-describedby={`${controlId}-hint`}
      aria-controls={showCommands && commands.length > 0 ? `${controlId}-commands` : undefined}
      aria-activedescendant={showCommands && commands.length > 0 ? `${controlId}-command-${commandIndex}` : undefined}
    />}
    </div>
    </div>
    <p id={`${controlId}-hint`} hidden={forcedReadOnly} className={`agent-composer-note${readOnly ? '' : ' agent-visually-hidden'}`}>{readOnly ? readOnlyHint : <>{nativeBusy ? 'Enter to send now' : 'Enter to send'} · Shift+Enter or hold Send for a new line · / for commands</>}</p>
    {!ownershipReadOnly ? <div className="agent-composer-actions">
      <div className="agent-composer-secondary-controls">
        {richEnabled ? <><button type="button" aria-label="Add images" disabled={!state?.agent || readOnly || busy} onClick={() => { filePickerAgent.current = agentId; editorRef.current?.captureSelection(); fileInputRef.current?.click(); }}>Image</button>
          <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (filePickerAgent.current === agentId) editorRef.current?.insertParts(imageDraft.addFiles(files)); }} /></> : null}
        <button hidden={compact} type="button" aria-label="Open chat commands" disabled={!ready || busy || (readOnly && consoleCommands.length === 0)} onClick={() => { currentDraft.commandsOpen = !currentDraft.commandsOpen; currentDraft.commandsDismissed = false; refresh((value) => value + 1); focusInput(); }}>/</button>
        {canQueue ? <button type="button" data-testid="queue-submit" aria-label={pending === 'queue' ? 'Queueing…' : 'Queue for next turn'} disabled={!session.operations.queue_message.allowed || waiting.items.length > 0 || !ready || !capabilities?.sendMessage || !hasContent || !imageSendReady || isCommand || Boolean(selectedSkill) || busy || (!onSendMessage && !onSendMessageContent)} title="Let the native Provider handle this after the current turn" onClick={() => void run('queue')}>{pending === 'queue' ? 'Queueing…' : 'Queue'}</button> : null}
      </div>
      {state?.agent && !compact ? <AgentSessionSettings sessionState={session} key={agentId} state={state} disabled={disabled} readOnly={forcedReadOnly} view={currentDraft.view} busy={busy}
        onView={(view) => { currentDraft.view = view; refresh((value) => value + 1); }}
        onPendingChange={(value) => { currentDraft.settingPending = value; if (mounted.current) refresh((count) => count + 1); }}
        onSelect={onSetSessionSetting} renderError={renderSessionSettingError}>{sessionControls}</AgentSessionSettings> : null}
      {state?.agent ? <AgentActivityStatus sessionState={session} visible={activityVisible} state={state} disabled={disabled} disabledLabel={disabledLabel}
        commandPending={pending === 'command'}
        interruptDisabled={!canInterrupt || currentDraft.interruptPending === true || (pending !== undefined && pending !== 'command') || !onCancel}
        interruptLabel={currentDraft.interruptPending ? 'Interrupting…' : interruptRequested ? 'Interrupt requested' : 'Interrupt'}
        onInterrupt={() => void run('cancel')} /> : null}
      <button type="button" data-testid="prompt-submit" aria-label={pending === 'send' ? 'Sending…' : 'Send message'} title={`${nativeBusy ? 'Send input to the active native turn' : 'Start a new native turn'} · Hold for a new line`} disabled={!canSubmit || readOnly || busy || (selectedSkill ? nativeBusy || !onExecuteCommand : !hasContent || (!imageSendReady && !canWait) || (!isCommand && (capabilities?.sendMessage !== true || (!onSendMessage && !onSendMessageContent))))} {...sendButtonPress}><span aria-hidden="true">{pending === 'send' ? '…' : '↑'}</span></button>
    </div> : null}
    {waiting.items[0]?.phase === 'error' ? <p className="agent-composer-note" role="alert">
      {waiting.items[0].reason}{waiting.items[0].dispatched ? ' Check the conversation before dismissing this message to continue the queue.' : ''}
    </p> : null}
    {richEnabled && imageDraft.storageError ? <div className="agent-composer-note agent-draft-storage-status" role="status">
      <span>{imageDraft.storageError}</span>
      <button type="button" onClick={imageDraft.retryStorage} disabled={imageDraft.storageBusy} aria-label="Retry draft storage">Retry</button>
    </div> : null}
    {richEnabled && imageDraft.error ? <p className="agent-composer-note" role="alert">{imageDraft.error}</p> : null}
    {hasImages ? <ImageUploadStatus parts={imageDraft.parts} images={imageDraft.images} connected={ready} onOpen={imageId => editorRef.current?.openImage(imageId)} /> : null}
    {!ownershipReadOnly && runtimeUnavailable ? <p className="agent-composer-note" role="status">{runtimeUnavailable}</p>
      : !ownershipReadOnly && !state?.agent ? <p className="agent-composer-note">Open or attach to an Agent first.</p> : null}
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
