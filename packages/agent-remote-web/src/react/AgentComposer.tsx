import type { ImageDraftBinding, ImageDraftRecipient } from '../image-drafts.js';
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
import { useResourceDraft, type UploadResource } from './useResourceDraft.js';
import { ImageUploadStatus } from './ImageUploadStatus.js';
import { useImageDraft, type UploadImage } from './useImageDraft.js';
import { draftHasContent, snapshotContent } from './composer-document.js';
import type { MessagePart } from '@orchardworks/agent-remote-protocol';
import { useSendButtonPress } from './useSendButtonPress.js';
import { usePendingSend } from './usePendingSend.js';
import { PendingSendQueue } from './PendingSendQueue.js';
import { AgentActionToolbar, type ComposerAction } from './AgentActionToolbar.js';

export interface PendingFirstInputContext {
  state: 'restoring' | 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'unavailable';
  onRetry?(): void;
}
export interface AgentComposerProps {
  sessionState?: RemoteSessionState;
  /** @deprecated Layout follows the containing Session View; this option no longer hides controls. */
  compact?: boolean;
  /** Prevent editing while preserving capabilities and the current draft. */
  readOnly?: boolean;
  /** Keep local storage editing available while native attachment is unavailable. */
  draftOnly?: boolean;
  /** Preserve draft editing while a handoff reserves native mutations. */
  mutationBlocked?: boolean;
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
  /** Host-confirmed captured history still awaiting native first-input materialization. */
  pendingFirstInputContext?: PendingFirstInputContext;
  visible?: boolean;
  activityVisible?: boolean;
  draftScope?: string;
  imageDraftBinding?: ImageDraftBinding;
  imageRecipient?: ImageDraftRecipient;
  onUploadImage?: UploadImage;
  onUploadResource?: UploadResource;
  onSendMessageContent?(content: readonly MessagePart[], options?: AgentMessageOptions & { imageDigests?: Readonly<Record<string, string>> }): Promise<void>;
  draft?: string;
  onDraftChange?(text: string): void;
  /** Current-session waiting messages and unsettled message submissions. */
  onPendingInputChange?(count: number): void;
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

export function AgentComposer({ sessionState: suppliedSessionState, readOnly: forcedReadOnly = false, draftOnly = false, mutationBlocked = false, readOnlyLabel, readOnlyNotice, readOnlyCollapsed = false, state, sessionControls, renderSessionSettingError, sessionKey, disabled = false, disabledLabel, recovering = false, pendingFirstInputContext: firstInputContext, draft: controlledDraft, onDraftChange, onPendingInputChange, onSendMessage, onCancel, onSetSessionSetting, onListCommands, onExecuteCommand, onInspectCommand, onRequestResource, onResolveResource, attachments, consoleCommands = [], onExecuteConsoleCommand, visible = true, activityVisible = visible, draftScope, imageDraftBinding, imageRecipient, onUploadImage, onUploadResource, onSendMessageContent }: AgentComposerProps) {
  const pendingFirstInputContext = firstInputContext !== undefined;
  const controlId = `composer-${useId().replace(/:/gu, '')}`;
  const drafts = useRef(new Map<string, Draft>());
  const agentId = sessionKey ?? state?.agent?.id ?? '';
  const editorIdentity = imageDraftBinding ? JSON.stringify([imageDraftBinding.scope, imageDraftBinding.key]) : agentId;
  const waiting = usePendingSend(JSON.stringify([draftScope, agentId]), visible);
  const currentAgent = useRef(agentId);
  currentAgent.current = agentId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const filePickerAgent = useRef<string>();
  const resourceInputRef = useRef<HTMLInputElement>(null);
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
  const pendingInputCount = waiting.items.length + (pending === 'send' || pending === 'queue' ? 1 : 0);
  const pendingInputObserver = useRef(onPendingInputChange); pendingInputObserver.current = onPendingInputChange;
  useLayoutEffect(() => { pendingInputObserver.current?.(pendingInputCount); }, [agentId, pendingInputCount]);
  const operationBusy = Boolean(pending || currentDraft.settingPending || currentDraft.interruptPending);
  const busy = operationBusy;
  const session = suppliedSessionState ?? remoteSessionState(state, disabled ? 'connecting' : 'ready');
  const activitySession = draftOnly ? remoteSessionState(undefined, session.connection === 'ready' ? 'connecting' : session.connection) : session;
  const capabilities = state?.agent?.capabilities;
  const runtimeConnection = session.runtime;
  const runtimeUnavailable = runtimeConnectionMessage(runtimeConnection?.state);
  const controlChecking = session.controlChecking;
  const ready = !draftOnly && !mutationBlocked && session.synchronized && !disabled && !forcedReadOnly && !session.readOnly && !controlChecking && runtimeUnavailable === undefined;
  const readOnly = forcedReadOnly || !draftOnly && (session.readOnly || capabilities?.sendMessage === false);
  const terminal = state?.agent?.status === 'failed' || state?.agent?.status === 'closed';
  const canWait = !draftOnly && !mutationBlocked && (session.recovering || recovering || disabled || controlChecking || runtimeConnection?.state === 'reconnecting' || runtimeConnection?.state === 'restoring') && Boolean(state?.agent) && !readOnly && !terminal && runtimeConnection?.state !== 'unavailable';
  const richEnabled = Boolean(imageDraftBinding || capabilities?.imageInput || capabilities?.resourceInput);
  const imageDraft = useImageDraft({ scope: draftScope, sessionKey: agentId, binding: imageDraftBinding, recipient: imageRecipient, text, enabled: richEnabled, active: visible && ready && !readOnly && !pendingFirstInputContext && Boolean(capabilities?.imageInput), upload: onUploadImage,
    onTextChange: value => { currentDraft.text = value; onDraftChange?.(value); refresh(count => count + 1); } });
  const hasImages = richEnabled && imageDraft.hasImages;
  const resourceDraft = useResourceDraft({ scope: imageDraftBinding?.scope ?? draftScope, sessionKey: imageDraftBinding?.key ?? agentId, parts: imageDraft.parts, documentHydrated: imageDraft.hydrated,
    active: visible && ready && !readOnly && !pendingFirstInputContext && Boolean(capabilities?.resourceInput) && (!imageDraftBinding || Boolean(imageRecipient?.isCurrent())), limits: capabilities?.resourceInput, upload: onUploadResource, recipient: imageRecipient });
  const hasResources = imageDraft.parts.some(part => part.type === 'resource');
  const hasAttachments = hasImages || hasResources;
  const hasContent = richEnabled ? draftHasContent(imageDraft.parts) : Boolean(text.trim());
  const ownershipReadOnly = forcedReadOnly && Boolean(readOnlyNotice);
  const hideDraft = ownershipReadOnly && (readOnlyCollapsed || (!hasContent && !attachments && !currentDraft.selectedSkill));
  const imageSendReady = (!hasImages || !pendingFirstInputContext && imageDraft.ready) && (!hasResources || resourceDraft.ready);
  const firstInputImageNotice = 'The first message must contain only text. Images can be sent after the previous history is included.';
  const isCommand = !hasAttachments && text.trimStart().startsWith('/');
  const nativeCommandsEnabled = !draftOnly && !mutationBlocked && !readOnly && capabilities?.commands === true;
  const readOnlyHint = 'This session is read-only. Direct input is disabled.';
  const wantsCommands = !draftOnly && !currentDraft.commandsDismissed && Boolean((!readOnly && isCommand) || currentDraft.commandsOpen);
  const directory = useAgentCommands(agentId, ready && wantsCommands && nativeCommandsEnabled, onListCommands);
  const commandQuery = !readOnly && isCommand ? text.trimStart().slice(1) : '';
  const availableCommands = [...consoleCommands, ...(readOnly ? [] : directory.commands).filter((command) => !consoleCommands.some((local) => local.name === command.name || local.aliases?.includes(command.name)))];
  const commands = availableCommands.filter((command) => command.name.startsWith(commandQuery) || (commandQuery && consoleCommands.find((local) => local.id === command.id)?.aliases?.some((alias) => alias.startsWith(commandQuery))));
  const showCommands = wantsCommands && (!readOnly || consoleCommands.length > 0) && !/\s/u.test(commandQuery);
  const commandIndex = Math.min(currentDraft.commandIndex ?? 0, Math.max(0, commands.length - 1));
  const activeTurnId = state?.agent?.activeTurn?.turnId;
  const nativeBusy = session.busy;
  const canQueue = !draftOnly && nativeBusy && capabilities?.queueMessage === true;
  const selectedSkill = currentDraft.selectedSkill;
  const canSubmit = (!hasResources || ready && waiting.items.length === 0) && ((ready && (isCommand || selectedSkill ? session.operations.execute_command.allowed || consoleCommands.length > 0 : session.operations.send_message.allowed)) || (canWait && !isCommand && !selectedSkill));
  if (activeTurnId === undefined) currentDraft.interruptedTurnId = undefined;
  const interruptRequested = (activeTurnId !== undefined && currentDraft.interruptedTurnId === activeTurnId)
    || (pending === 'command' && currentDraft.commandInterrupted === true);
  const canInterrupt = ready && session.operations.cancel.allowed && (session.busy || pending === 'command')
    && state?.agent?.status !== 'failed' && state?.agent?.status !== 'closed' && !interruptRequested;

  const dispatchReady = ready && !readOnly && !terminal && !operationBusy && session.operations.send_message.allowed;
  const latest = useRef({ agentId, draftOnly, mutationBlocked, dispatchReady, pendingFirstInputContext, onSendMessage, onSendMessageContent, onUploadImage, imageRecipient });
  latest.current = { agentId, draftOnly, mutationBlocked, dispatchReady, pendingFirstInputContext, onSendMessage, onSendMessageContent, onUploadImage, imageRecipient };
  const richPreparations = useRef(new Map<AbortController, ImageDraftRecipient>());
  for (const [abort, owner] of richPreparations.current) {
    if (draftOnly || mutationBlocked || pendingFirstInputContext || imageRecipient?.identity !== owner.identity || imageRecipient?.lifetime !== owner.lifetime || !owner.isCurrent()) abort.abort();
  }
  function blockFirstInputImages(): boolean {
    if (!latest.current.pendingFirstInputContext) return false;
    currentDraft.feedback = { kind: 'error', message: firstInputImageNotice };
    refresh(value => value + 1);
    return true;
  }
  const addImageFiles: typeof imageDraft.addFiles = (files, replacingImageId) => blockFirstInputImages() ? [] : imageDraft.addFiles(files, replacingImageId);
  const importImageParts: typeof imageDraft.importParts = parts => parts.some(part => part.type === 'image') && blockFirstInputImages() ? [] : imageDraft.importParts(parts);
  function deferMessage(): void {
    if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
    if (hasImages && blockFirstInputImages()) return;
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
        return current.agentId === agentId && (!containsImages || !current.pendingFirstInputContext && (!imageDraftBinding || !!current.imageRecipient) && (!imageRecipient || current.imageRecipient?.identity === imageRecipient.identity && current.imageRecipient.isCurrent())) && current.dispatchReady && Boolean(containsImages ? current.onSendMessageContent && current.onUploadImage : current.onSendMessage);
      },
      async send(signal, dispatch) {
        signal.throwIfAborted();
        const selectedRecipient = latest.current.imageRecipient;
        const preparation = new AbortController();
        const abortPreparation = () => preparation.abort();
        signal.addEventListener('abort', abortPreparation, { once: true });
        if (selectedRecipient) richPreparations.current.set(preparation, selectedRecipient);
        const checkRecipient = () => {
          if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) throw new Error('Native attachment is unavailable.');
          if (containsImages && latest.current.pendingFirstInputContext) throw new Error(firstInputImageNotice);
          signal.throwIfAborted(); preparation.signal.throwIfAborted();
          if (selectedRecipient && (!selectedRecipient.isCurrent() || latest.current.imageRecipient?.identity !== selectedRecipient.identity
            || latest.current.imageRecipient?.lifetime !== selectedRecipient.lifetime)) throw new Error('The image recipient changed. Retry for the current connection.');
        };
        try {
        checkRecipient();
        const upload = latest.current.onUploadImage!;
        const richSend = latest.current.onSendMessageContent;
        const textSend = latest.current.onSendMessage;
        const attachments: Record<string, Awaited<ReturnType<UploadImage>>> = {};
        for (const [id, image] of Object.entries(images)) {
          if (!image.blob) throw new Error('Local image bytes are missing. Copy the message and attach the image again.');
          attachments[id] = await upload(image.blob, image.uploadId, { signal: preparation.signal });
          checkRecipient();
        }
        const content = containsImages ? snapshotContent(parts, attachments) : undefined;
        if (!dispatch()) return;
        if (content) await richSend!(content, {
          imageDigests: Object.fromEntries(Object.values(attachments).map(image => [image.attachmentId, image.sha256])),
        });
        else await textSend!(submitted.trim());
        } finally { richPreparations.current.delete(preparation); signal.removeEventListener('abort', abortPreparation); }
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
  useEffect(() => {
    if (!pendingFirstInputContext && currentDraft.feedback?.message === firstInputImageNotice) {
      currentDraft.feedback = undefined;
      refresh(value => value + 1);
    }
  }, [agentId, pendingFirstInputContext]);
  useLayoutEffect(() => { composing.current = false; }, [agentId]);
  useLayoutEffect(() => {
    if (showCommands) inputRef.current?.parentElement?.querySelector(`#${controlId}-command-${commandIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [commandIndex, showCommands]);
  useLayoutEffect(() => {
    if (readOnly) focusRequested.current = undefined;
    const input = inputRef.current;
    if (!input) { if (focusRequested.current === agentId && !pending && visible) { focusRequested.current = undefined; editorRef.current?.focus(); } return; }
    const resize = () => {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    };
    resize();
    if (focusRequested.current === agentId && !pending) {
      focusRequested.current = undefined;
      if (!input.closest('[hidden]')) input.focus({ preventScroll: true });
    }
    let width = input.getBoundingClientRect().width;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      const nextWidth = input.getBoundingClientRect().width;
      if (nextWidth === width) return;
      width = nextWidth;
      resize();
    });
    observer?.observe(input);
    return () => observer?.disconnect();
  }, [agentId, text, pending, readOnly, hideDraft, richEnabled]);

  function chooseCommand(command: AgentCommand): void {
    if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
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
    if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
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
    if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
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
    if (hasImages && blockFirstInputImages()) return;
    if (kind === 'queue' && latest.current.pendingFirstInputContext) return;
    if (hasAttachments && currentDraft.selectedSkill) { currentDraft.feedback = { kind: 'error', message: 'Remove the selected skill before sending attachments.' }; refresh(value => value + 1); return; }
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
    if (hasResources && waiting.items.length > 0) return;
    const action = onSendMessage;
    if (!hasResources && kind === 'send' && (!ready || waiting.items.length > 0) && (ready || canWait) && !operationBusy && hasContent && capabilities?.sendMessage && (hasImages ? onSendMessageContent : action)) { deferMessage(); return; }
    if ((hasAttachments ? !onSendMessageContent : !action) || currentDraft.pending || currentDraft.settingPending || !ready || !hasContent || !imageSendReady) return;
    if (!(kind === 'queue' ? session.operations.queue_message.allowed : session.operations.send_message.allowed) || (kind === 'queue' && (!canQueue || waiting.items.length > 0))) return;
    const submitted = currentDraft.text;
    const submittedParts = imageDraft.parts;
    const content = hasAttachments ? resourceDraft.snapshot(imageDraft.snapshot()) : undefined;
    const imageDigests = content ? imageDraft.digests() : undefined;
    const ownsImageEdit = imageDraft.captureEdit();
    currentDraft.pending = kind;
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      if (content) await onSendMessageContent!(content, { ...(kind === 'queue' ? { delivery: 'next_turn' as const } : {}), imageDigests });
      else if (kind === 'queue') await action!(submitted.trim(), { delivery: 'next_turn' });
      else await action!(submitted.trim());
      if (currentDraft.text === submitted && (!richEnabled || ownsImageEdit() && imageDraft.parts === submittedParts)) {
        if (hasResources) resourceDraft.clear();
        if (richEnabled) imageDraft.setText(''); else { currentDraft.text = ''; if (currentAgent.current === agentId) onDraftChange?.(''); }
      }
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? 'Message sent.' : 'Message queued by Provider.', delivery: true };
      if (currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      if (content && ownsImageEdit() && error && typeof error === 'object' && 'code' in error && error.code === 'invalid_image_input') {
        imageDraft.rejectAttachments(content, 'The Host could not use this image. Retry the upload, replace it, or remove it.');
      }
      if (content && ownsImageEdit() && error && typeof error === 'object' && 'code' in error && error.code === 'invalid_resource_input') resourceDraft.reject(content, 'The Host could not use this resource. Retry the upload or remove it.');
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

  const toolbarActions: ComposerAction[] = [];
  if (richEnabled && (imageDraftBinding || capabilities?.imageInput)) toolbarActions.push({ id: 'images', label: 'Add images', content: 'Image', priority: 20,
    title: pendingFirstInputContext ? firstInputImageNotice : undefined,
    disabled: (!state?.agent && !draftOnly) || readOnly || busy || pendingFirstInputContext,
    run: () => { filePickerAgent.current = agentId; editorRef.current?.captureSelection(); fileInputRef.current?.click(); } });
  if (capabilities?.resourceInput) toolbarActions.push({ id: 'resources', label: 'Add resources', content: 'Resource', priority: 19,
    title: pendingFirstInputContext ? 'Resources can be sent after the previous history is included.' : undefined,
    disabled: !ready || readOnly || busy || pendingFirstInputContext || !onUploadResource || !resourceDraft.hydrated,
    run: () => { filePickerAgent.current = agentId; editorRef.current?.captureSelection(); resourceInputRef.current?.click(); } });
  toolbarActions.push({ id: 'commands', label: 'Open chat commands', content: '/',
    disabled: !ready || busy || (readOnly && consoleCommands.length === 0),
    run: () => { currentDraft.commandsOpen = !currentDraft.commandsOpen; currentDraft.commandsDismissed = false; refresh(value => value + 1); focusInput(); } });
  if (canQueue) toolbarActions.push({ id: 'queue', label: pending === 'queue' ? 'Queueing…' : 'Queue for next turn', content: pending === 'queue' ? 'Queueing…' : 'Queue', testId: 'queue-submit',
    title: pendingFirstInputContext ? 'The first message must use immediate delivery.' : 'Let the native Provider handle this after the current turn',
    disabled: pendingFirstInputContext || !session.operations.queue_message.allowed || waiting.items.length > 0 || !ready || !capabilities?.sendMessage || !hasContent || !imageSendReady || isCommand || Boolean(selectedSkill) || busy || (!onSendMessage && !onSendMessageContent),
    run: () => void run('queue') });

  return <section className="agent-composer" aria-label="Live provider controls" aria-busy={busy} data-control-readonly={ownershipReadOnly || undefined}>
    {richEnabled ? <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (filePickerAgent.current === agentId) editorRef.current?.insertParts(addImageFiles(files)); }} /> : null}
    {capabilities?.resourceInput ? <input ref={resourceInputRef} type="file" hidden multiple aria-label="Choose resources" onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
      if (filePickerAgent.current !== agentId) return;
      try { editorRef.current?.insertParts(resourceDraft.add(files)); } catch (error) { currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : 'Resource selection failed.' }; refresh(value => value + 1); }
    }} /> : null}
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
    {firstInputContext ? <p className="agent-composer-note" role="status">
      {firstInputContext.state === 'pending' ? 'History from the previous session will be included with your first message.'
        : firstInputContext.state === 'restoring' ? 'Checking history from the previous session…'
        : firstInputContext.state === 'unavailable' ? 'History delivery could not be checked. Images remain paused until it is confirmed.'
        : 'History delivery is not yet confirmed. Images remain paused.'}
      {firstInputContext.onRetry && ['unavailable', 'unknown', 'dispatching', 'accepted'].includes(firstInputContext.state) ? <> <button type="button" onClick={firstInputContext.onRetry}>Check again</button></> : null}
    </p> : null}
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
    {richEnabled ? <ComposerEditor key={editorIdentity} ref={editorRef} id={`${controlId}-input`} parts={imageDraft.parts} images={imageDraft.images}
      disabled={(!state?.agent && !draftOnly) || readOnly || busy} onChange={parts => { imageDraft.setParts(parts); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; }}
      onFiles={addImageFiles} onImport={importImageParts} onRetry={imageId => { if (!blockFirstInputImages()) imageDraft.retry(imageId); }} onKeyDown={handleKeyDown}
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
      disabled={!ownershipReadOnly && ((!state?.agent && !draftOnly) || readOnly || busy)}
      readOnly={ownershipReadOnly}
      placeholder={ownershipReadOnly ? '' : forcedReadOnly ? readOnlyLabel ?? 'This recording is read-only.' : readOnly ? readOnlyHint : state?.agent || draftOnly ? 'Message…' : 'Open or attach to an Agent first.'}
      aria-describedby={`${controlId}-hint`}
      aria-controls={showCommands && commands.length > 0 ? `${controlId}-commands` : undefined}
      aria-activedescendant={showCommands && commands.length > 0 ? `${controlId}-command-${commandIndex}` : undefined}
    />}
    </div>
    </div>
    <p id={`${controlId}-hint`} hidden={forcedReadOnly} className={`agent-composer-note${readOnly ? '' : ' agent-visually-hidden'}`}>{readOnly ? readOnlyHint : <>{nativeBusy ? 'Enter to send now' : 'Enter to send'} · Shift+Enter or hold Send for a new line · / for commands</>}</p>
    {!ownershipReadOnly ? <div className="agent-composer-actions">
      {state?.agent && !draftOnly ? <AgentSessionSettings actions={toolbarActions} sessionState={session} key={agentId} state={state} disabled={disabled} readOnly={forcedReadOnly} view={currentDraft.view} busy={busy}
        onView={(view) => { currentDraft.view = view; refresh((value) => value + 1); }}
        onPendingChange={(value) => { currentDraft.settingPending = value; if (mounted.current) refresh((count) => count + 1); }}
        onSelect={onSetSessionSetting && !mutationBlocked ? async (id, value) => { if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return; await onSetSessionSetting(id, value); } : undefined} renderError={renderSessionSettingError}>{sessionControls}</AgentSessionSettings> : <div className="agent-session-controls">
          <AgentActionToolbar actions={toolbarActions} overflowOpen={currentDraft.view === 'actions'}
            onOverflow={open => { currentDraft.view = open ? 'actions' : undefined; refresh(value => value + 1); }} />
        </div>}
      <AgentActivityStatus sessionState={activitySession} visible={activityVisible} state={state} disabled={disabled || draftOnly} disabledLabel={!draftOnly && state?.agent ? disabledLabel : undefined}
        commandPending={pending === 'command'}
        interruptDisabled={!canInterrupt || currentDraft.interruptPending === true || (pending !== undefined && pending !== 'command') || !onCancel}
        interruptLabel={currentDraft.interruptPending ? 'Interrupting…' : interruptRequested ? 'Interrupt requested' : 'Interrupt'}
        onInterrupt={() => void run('cancel')} />
      <button type="button" data-testid="prompt-submit" aria-label={pending === 'send' ? 'Sending…' : 'Send message'} title={hasImages && pendingFirstInputContext ? firstInputImageNotice : `${nativeBusy ? 'Send input to the active native turn' : 'Start a new native turn'} · Hold for a new line`} disabled={!canSubmit || readOnly || busy || hasImages && pendingFirstInputContext || (selectedSkill ? nativeBusy || !onExecuteCommand : !hasContent || (!imageSendReady && !canWait) || (!isCommand && (capabilities?.sendMessage !== true || (!onSendMessage && !onSendMessageContent))))} {...sendButtonPress}><span aria-hidden="true">{pending === 'send' ? '…' : '↑'}</span></button>
    </div> : null}
    {waiting.items[0]?.phase === 'error' ? <p className="agent-composer-note" role="alert">
      {waiting.items[0].reason}{waiting.items[0].dispatched ? ' Check the conversation before dismissing this message to continue the queue.' : ''}
    </p> : null}
    {richEnabled && imageDraft.storageError ? <div className="agent-composer-note agent-draft-storage-status" role="status">
      <span>{imageDraft.storageError}</span>
      <button type="button" onClick={imageDraft.retryStorage} disabled={imageDraft.storageBusy} aria-label="Retry draft storage">Retry</button>
    </div> : null}
    {richEnabled && imageDraft.error ? <p className="agent-composer-note" role="alert">{imageDraft.error}</p> : null}
    {hasImages && pendingFirstInputContext && feedback?.message !== firstInputImageNotice ? <p className="agent-composer-note" role="status">{firstInputImageNotice}</p> : null}
    {hasResources ? <div className="agent-resource-draft-list" aria-label="Resource uploads">{resourceDraft.items.map(({ id, label, record }) => <div className="agent-resource-draft" key={id}>
      <span><strong>[{label}]</strong> {record?.name ?? 'File unavailable'} {record ? <small>{record.file.size.toLocaleString()} bytes · {record.status === 'uploading' ? `Uploading ${Math.round(record.progress * 100)}%` : record.status === 'ready' ? 'Ready' : record.status}</small> : null}</span>
      {record?.error ? <span role="alert">{record.error}</span> : null}
      {record?.status === 'failed' ? <button type="button" disabled={!ready || busy} onClick={() => resourceDraft.retry(id)}>Retry {label}</button> : null}
      <button type="button" disabled={busy || readOnly} aria-label={`Remove ${label}`} onClick={() => imageDraft.setParts(imageDraft.parts.filter(part => part.type !== 'resource' || part.resourceId !== id))}>Remove</button>
    </div>)}</div> : null}
    {hasResources && (draftScope || imageDraftBinding?.scope) && !resourceDraft.storageError ? <p role="status" className="agent-composer-note">{imageDraft.storageSaved && !resourceDraft.storageBusy ? 'Resource draft saved on this device.' : 'Saving resource draft…'}</p> : null}
    {hasResources && resourceDraft.storageError ? <p role="status" className="agent-composer-note">{resourceDraft.storageError}</p> : null}
    {hasResources && !ready ? <p role="status" className="agent-composer-note">Resources remain in your draft. Reconnect before sending.</p> : null}
    {hasImages ? <ImageUploadStatus parts={imageDraft.parts} images={imageDraft.images} connected={ready} onOpen={imageId => editorRef.current?.openImage(imageId)} /> : null}
    {!ownershipReadOnly && runtimeUnavailable ? <p className="agent-composer-note" role="status">{runtimeUnavailable}</p>
      : !ownershipReadOnly && !draftOnly && !state?.agent ? <p className="agent-composer-note">Open or attach to an Agent first.</p> : null}
    {feedback && !(feedback.delivery && state?.outgoingMessages !== undefined) ? <p className="agent-composer-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
    {!draftOnly && !onInspectCommand && currentDraft.inspectedSkill && state ? <AgentCommandDetails key={`${agentId}:${currentDraft.inspectedSkill.id}`}
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
