import type { ImageDraftBinding, ImageDraftRecipient } from '../image-drafts.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { isCoarsePointer, returnKeyAction } from './return-key.js';
import { AgentSessionSettings, type SessionControlView } from './AgentSessionSettings.js';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions, ResourceBinding } from '@orchardworks/agent-remote-protocol';
import { AgentCommandDetails } from './AgentCommandDetails.js';
import { useAgentCommands } from './useAgentCommands.js';
import { AgentActivityStatus } from './AgentActivityStatus.js';
import { InterruptButton } from './InterruptButton.js';
import { ComposerMenu, type ComposerMenuEntry } from './ComposerMenu.js';
import { composerMenu } from './composer-menu.js';
import { useTranslate } from './locale.js';
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor.js';
import { useResourceDraft, type UploadResource } from './useResourceDraft.js';
import { ImageUploadStatus } from './ImageUploadStatus.js';
import { useImageDraft, type UploadImage } from './useImageDraft.js';
import type { DraftPart } from './composer-document.js';
import { draftHasContent, snapshotContent } from './composer-document.js';
import { useComposerKeyboardDismiss } from './useComposerKeyboardDismiss.js';
import type { MessagePart } from '@orchardworks/agent-remote-protocol';
import { useSendButtonPress } from './useSendButtonPress.js';
import { usePendingSend } from './usePendingSend.js';
import { SharedByKey } from './shared-by-key.js';
import { PendingSendQueue } from './PendingSendQueue.js';
import { composerAvailability, remoteSessionState, type MessageKey, type RemoteSessionState, type AgentReplicaState, type SessionFacts } from '@orchardworks/agent-client';

/** A command of the page's own (a console command such as /ask or /handoff): its description's catalogue key says it in the reader's words. */
export type ConsoleCommand = AgentCommand & { aliases?: readonly string[]; descriptionKey?: MessageKey };

export interface PendingFirstInputContext {
  state: 'restoring' | 'pending' | 'dispatching' | 'accepted' | 'unknown' | 'unavailable';
  onRetry?(): void;
}
export interface AgentComposerProps {
  /** Stable ancestor containing this composer and adjacent controls that share its touch gestures. */
  keyboardDismissBoundaryRef?: RefObject<HTMLElement>;
  /** The session's facts; the composer reads its availability from `composerAvailability` and nothing else about the connection. */
  sessionState: RemoteSessionState;
  /** The session's Host as the Relay last said; an offline Host leaves the composer enabled. */
  host?: SessionFacts['host'];
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
  /** Whom the message goes to: the placeholder says "Message {recipient}…". */
  recipient?: string;
  /** Retain ownership controls while hiding the preserved draft. */
  readOnlyCollapsed?: boolean;
  state?: AgentReplicaState;
  sessionControls?: ReactNode;
  /** `inline` shows the Model, Permissions and status controls beside the actions; `none` leaves them to a details panel and keeps the action toolbar, activity status and send. */
  settings?: 'inline' | 'none';
  renderSessionSettingError?(error: unknown): ReactNode;
  /** Presents a failed command in place of its message, such as a sign-in it needs; nothing keeps the message. */
  renderCommandError?(error: unknown): ReactNode;
  attachments?: ReactNode;
  consoleCommands?: readonly ConsoleCommand[];
  onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>;
  sessionKey?: string;
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
  /** The view is a stand-in that shows the session while the Window that will own it loads: plain messages typed into it wait for the pane that replaces it. */
  opening?: boolean;
  draft?: string;
  onDraftChange?(text: string): void;
  /**
   * Sends text to a session whose Host is offline: the message waits for the Host and is delivered when it returns. Given
   * only while the Host is offline, it replaces sending, even if the session still looks attached. label names the
   * action, for example "Send when Mac mini is back".
   */
  sendLater?: { label: string; send(text: string): Promise<void> };
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

/** A plain-text or image message that waits for its session: data only, so any composer for the session can deliver it. */
interface PendingMessage {
  agentId: string; containsImages: boolean; submitted: string; parts: readonly DraftPart[];
  images: Record<string, { blob: Blob | undefined; uploadId: string }>;
  imageRecipient: ImageDraftRecipient | undefined; hadImageBinding: boolean;
}

/** How long a replacing composer keeps trying to take over the focus of the one it replaced. */
const FOCUS_HANDOVER_MS = 2000;

/** Sessions whose composer was replaced while it had focus, until the commit that mounts the next one has run. */
const focusHandoffs = new Set<string>();

/** The drafts of the sessions on this page, shared by every composer that shows the same session. */
const composerDrafts = new SharedByKey<Draft>();

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
  feedback?: { kind: 'success' | 'error'; message: string; delivery?: boolean; commandError?: unknown };
}

export function AgentComposer({ keyboardDismissBoundaryRef, sessionState: suppliedSessionState, readOnly: forcedReadOnly = false, draftOnly: draftOnlyRequested = false, opening = false, mutationBlocked = false, readOnlyLabel, readOnlyNotice, recipient, readOnlyCollapsed = false, state, sessionControls, settings = 'inline', renderSessionSettingError, renderCommandError, sessionKey, host, pendingFirstInputContext: firstInputContext, draft: controlledDraft, onDraftChange, onPendingInputChange, onSendMessage, onCancel, onSetSessionSetting, onListCommands, onExecuteCommand, onInspectCommand, onRequestResource, onResolveResource, attachments, consoleCommands = [], onExecuteConsoleCommand, visible = true, activityVisible = visible, draftScope, imageDraftBinding, imageRecipient, onUploadImage, onUploadResource, onSendMessageContent, sendLater }: AgentComposerProps) {
  const t = useTranslate();
  const draftOnly = draftOnlyRequested;
  const pendingFirstInputContext = firstInputContext !== undefined;
  const controlId = `composer-${useId().replace(/:/gu, '')}`;
  const composerRef = useComposerKeyboardDismiss(keyboardDismissBoundaryRef);
  const agentId = sessionKey ?? state?.agent?.id ?? '';
  const editorIdentity = imageDraftBinding ? JSON.stringify([imageDraftBinding.scope, imageDraftBinding.key]) : agentId;
  // The executor reads `latest` and `richPreparations`, declared below; the queue calls it only after this render has finished.
  const waiting = usePendingSend<PendingMessage>(JSON.stringify([draftScope, agentId]), visible, {
    ready: message => readyToDeliver(message),
    send: (message, signal, dispatch) => deliver(message, signal, dispatch),
  });
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
  const draftKey = JSON.stringify([draftScope, agentId]);
  const currentDraft = composerDrafts.get(draftKey, () => ({ text: '' }));
  // The drafts of every session this composer showed stay held until it unmounts; the composer that replaces it finds them.
  const heldDrafts = useRef(new Map<string, () => void>());
  useLayoutEffect(() => {
    if (!heldDrafts.current.has(draftKey)) heldDrafts.current.set(draftKey, composerDrafts.hold(draftKey));
  }, [draftKey]);
  useLayoutEffect(() => () => { for (const release of heldDrafts.current.values()) release(); heldDrafts.current.clear(); }, []);
  if (controlledDraft !== undefined) currentDraft.text = controlledDraft;
  function setText(value: string): void { currentDraft.text = value; if (richEnabled) imageDraft.setText(value); else onDraftChange?.(value); }
  // A composer that is replaced while it has focus hands the focus to the one that takes its place, with the caret after the text.
  // The editor may still be disabled in its first renders, so the hand-over repeats until the editor takes the focus, the person
  // focuses something else, or the moment has passed.
  const focusHandover = useRef<number>();
  useLayoutEffect(() => { if (focusHandoffs.delete(draftKey)) focusHandover.current = Date.now() + FOCUS_HANDOVER_MS; }, []);
  useLayoutEffect(() => {
    const until = focusHandover.current;
    if (until === undefined) return;
    const root = composerRef.current;
    const active = document.activeElement;
    if (Date.now() > until || (active && active !== document.body && !root?.contains(active))) { focusHandover.current = undefined; return; }
    if (root?.contains(active)) { focusHandover.current = undefined; return; }
    if (richEnabled) editorRef.current?.focus({ atEnd: true });
    else { const input = inputRef.current; if (input && !input.disabled) { input.focus({ preventScroll: true }); input.setSelectionRange(input.value.length, input.value.length); } }
    if (root?.contains(document.activeElement)) focusHandover.current = undefined;
  });
  const rootForFocus = composerRef;
  useLayoutEffect(() => () => {
    if (!rootForFocus.current?.contains(document.activeElement)) return;
    focusHandoffs.add(draftKey);
    queueMicrotask(() => focusHandoffs.delete(draftKey));
  }, [draftKey]);
  function focusInput(): void { if (richEnabled) editorRef.current?.focus(); else inputRef.current?.focus(); }
  const { text, pending, feedback } = currentDraft;
  const commandRecovery = feedback && 'commandError' in feedback ? renderCommandError?.(feedback.commandError) : undefined;
  const pendingInputCount = waiting.items.length + (pending === 'send' || pending === 'queue' ? 1 : 0);
  const pendingInputObserver = useRef(onPendingInputChange); pendingInputObserver.current = onPendingInputChange;
  useLayoutEffect(() => { pendingInputObserver.current?.(pendingInputCount); }, [agentId, pendingInputCount]);
  const operationBusy = Boolean(pending || currentDraft.settingPending || currentDraft.interruptPending);
  const busy = operationBusy;
  const session = suppliedSessionState;
  const activitySession = draftOnly ? remoteSessionState(undefined, session.connection) : session;
  const capabilities = state?.agent?.capabilities;
  // Only a business reason blocks input (target T4). A send goes now, or waits in the queue until the session is ready.
  const availability = composerAvailability({ session, host, replica: state }, t);
  const dispatch = availability.input === 'enabled' && !draftOnly && !mutationBlocked && !forcedReadOnly && agentId !== '' ? availability.dispatch : undefined;
  const sendNow = dispatch === 'now';
  // A stand-in view (`opening`) keeps the editor and takes a plain message into the queue, which the pane that
  // replaces it delivers once the session is ready; a draft-only view that could not open holds it.
  const waitsWhileOpening = opening && draftOnly && !mutationBlocked && !forcedReadOnly && agentId !== '';
  const canWait = dispatch === 'when_ready' || waitsWhileOpening;
  // Commands, skills, files and next-turn queueing need the session itself and wait for it (owner decision 3): synchronized, its
  // control check over and its runtime connected, which is when any operation is admitted. Only a plain send waits in the queue.
  const ready = !draftOnly && !mutationBlocked && !forcedReadOnly && agentId !== '' && !session.readOnly && session.operations.interaction_response.allowed;
  const readOnly = forcedReadOnly || !draftOnly && (session.readOnly || capabilities?.sendMessage === false);
  const blocked = !draftOnly && availability.input === 'disabled';
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
  const firstInputImageNotice = t('composer.imagesAfterHistory');
  const isCommand = !hasAttachments && text.trimStart().startsWith('/');
  const nativeCommandsEnabled = !draftOnly && !mutationBlocked && !readOnly && capabilities?.commands === true;
  const readOnlyHint = t('composer.readOnlyHint');
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

  // While the Host is offline, text can still be sent to wait for it; images, files and commands need the Host itself.
  const laterMode = !!sendLater && !mutationBlocked && !forcedReadOnly;
  const laterBlocked = !laterMode ? undefined : hasAttachments ? t('composer.laterAttachments')
    : isCommand || currentDraft.selectedSkill ? t('composer.laterCommands') : undefined;
  const dispatchReady = sendNow && !operationBusy;
  const sendAllowed = sendNow;
  const queueAllowed = ready && session.operations.queue_message.allowed;
  const latest = useRef({ waitsWhileOpening, agentId, draftOnly, mutationBlocked, dispatchReady, sendAllowed, queueAllowed, pendingFirstInputContext, onSendMessage, onSendMessageContent, onUploadImage, imageRecipient });
  latest.current = { waitsWhileOpening, agentId, draftOnly, mutationBlocked, dispatchReady, sendAllowed, queueAllowed, pendingFirstInputContext, onSendMessage, onSendMessageContent, onUploadImage, imageRecipient };
  // A message that waits for a session that cannot take it does not stay Sending, and is never sent unasked later.
  const unsendable = availability.input === 'disabled' && !draftOnly ? availability.words : draftOnly && !waitsWhileOpening && !laterMode && agentId !== '' ? t('composer.openFailed') : undefined;
  useEffect(() => { if (unsendable) waiting.hold(unsendable); }, [unsendable, agentId, waiting.items.length]);
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
  function readyToDeliver(message: PendingMessage): boolean {
    const current = latest.current;
    return current.agentId === message.agentId && (!message.containsImages || !current.pendingFirstInputContext && (!message.hadImageBinding || !!current.imageRecipient) && (!message.imageRecipient || current.imageRecipient?.identity === message.imageRecipient.identity && current.imageRecipient.isCurrent())) && current.dispatchReady && Boolean(message.containsImages ? current.onSendMessageContent && current.onUploadImage : current.onSendMessage);
  }
  async function deliver(message: PendingMessage, signal: AbortSignal, dispatch: () => boolean): Promise<void> {
    const { agentId, containsImages, parts, images, submitted } = message;
    signal.throwIfAborted();
    const selectedRecipient = latest.current.imageRecipient;
    const preparation = new AbortController();
    const abortPreparation = () => preparation.abort();
    signal.addEventListener('abort', abortPreparation, { once: true });
    if (selectedRecipient) richPreparations.current.set(preparation, selectedRecipient);
    const checkRecipient = () => {
      if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) throw new Error(t('composer.attachmentUnavailable'));
      if (containsImages && latest.current.pendingFirstInputContext) throw new Error(firstInputImageNotice);
      signal.throwIfAborted(); preparation.signal.throwIfAborted();
      if (selectedRecipient && (!selectedRecipient.isCurrent() || latest.current.imageRecipient?.identity !== selectedRecipient.identity
        || latest.current.imageRecipient?.lifetime !== selectedRecipient.lifetime)) throw new Error(t('composer.recipientChanged'));
    };
    try {
    checkRecipient();
    const upload = latest.current.onUploadImage!;
    const richSend = latest.current.onSendMessageContent;
    const textSend = latest.current.onSendMessage;
    const attachments: Record<string, Awaited<ReturnType<UploadImage>>> = {};
    for (const [id, image] of Object.entries(images)) {
      if (!image.blob) throw new Error(t('composer.imageBytesMissingSend'));
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

  }
  function deferMessage(): void {
    if (latest.current.draftOnly && !latest.current.waitsWhileOpening || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
    if (hasImages && blockFirstInputImages()) return;
    // A second key press before this render saw the first one finds the draft already taken.
    if (!hasImages && !currentDraft.text.trim()) return;
    const submitted = currentDraft.text;
    const parts = imageDraft.parts.map(part => ({ ...part }));
    // Own the bytes independently of the editable draft and its upload lifecycle.
    const images = Object.fromEntries(parts.flatMap(part => part.type === 'image'
      ? [[part.imageId, { blob: imageDraft.images[part.imageId]?.blob, uploadId: crypto.randomUUID() }]] : []));
    const containsImages = hasImages;
    currentDraft.feedback = undefined;
    waiting.start({
      text: containsImages ? parts.map(part => part.type === 'text' ? part.text : `[${part.label}]`).join('') : submitted,
      payload: { agentId, containsImages, parts, images, submitted, imageRecipient, hadImageBinding: Boolean(imageDraftBinding) },
    });
    setText('');
    focusInput();
    refresh(value => value + 1);
  }

  const sendButtonPress = useSendButtonPress(agentId, (canSubmit || laterMode && !laterBlocked && hasContent) && !readOnly && !busy, () => {
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
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : t('composer.commandFailed'), commandError: error };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  async function submitLater(): Promise<void> {
    // The draft object holds the text typed so far, even before this render saw it.
    const submitted = currentDraft.text;
    if (!laterMode || laterBlocked || !submitted.trim() || currentDraft.pending || !sendLater) return;
    currentDraft.pending = 'send';
    currentDraft.feedback = undefined;
    refresh((value) => value + 1);
    try {
      await sendLater.send(submitted.trim());
      // The message now shows as waiting in the conversation; the composer is ready for the next one.
      if (currentDraft.text === submitted) { if (richEnabled) imageDraft.setText(''); else { currentDraft.text = ''; if (currentAgent.current === agentId) onDraftChange?.(''); } }
    } catch (error) {
      currentDraft.feedback = { kind: 'error', message: error instanceof Error && error.message ? error.message : t('composer.laterFailed') };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  async function run(kind: 'send' | 'queue' | 'cancel'): Promise<void> {
    if (kind === 'send' && laterMode && latest.current.agentId === agentId) { await submitLater(); return; }
    if (latest.current.draftOnly && !(kind === 'send' && latest.current.waitsWhileOpening) || latest.current.mutationBlocked || latest.current.agentId !== agentId) return;
    if (kind === 'cancel') {
      if (!onCancel || !canInterrupt || currentDraft.interruptPending) return;
      currentDraft.interruptPending = true;
      currentDraft.feedback = undefined;
      refresh((value) => value + 1);
      try {
        await onCancel();
        currentDraft.interruptedTurnId = activeTurnId;
        currentDraft.commandInterrupted = currentDraft.pending === 'command';
        currentDraft.feedback = { kind: 'success', message: t('composer.cancellationRequested') };
      } catch (error) {
        currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : t('composer.interruptFailed') };
      } finally {
        currentDraft.interruptPending = false;
        if (mounted.current) refresh((value) => value + 1);
      }
      return;
    }
    if (readOnly) return;
    if (hasImages && blockFirstInputImages()) return;
    if (kind === 'queue' && latest.current.pendingFirstInputContext) return;
    if (hasAttachments && currentDraft.selectedSkill) { currentDraft.feedback = { kind: 'error', message: t('composer.removeSkillFirst') }; refresh(value => value + 1); return; }
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
        currentDraft.feedback = { kind: 'error', message: directory.error ?? t('composer.unknownCommand') };
        refresh((value) => value + 1);
      }
      return;
    }
    if (hasResources && waiting.items.length > 0) return;
    const action = onSendMessage;
    // A plain send always goes through the queue, now or later: one path, and the editor is never disabled under it (Task 6).
    if (!hasResources && kind === 'send' && (!sendNow || waiting.items.length > 0 || !hasAttachments) && (sendNow || canWait) && !operationBusy && hasContent && capabilities?.sendMessage !== false && (canWait || (hasImages ? onSendMessageContent : action))) { deferMessage(); return; }
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
      if (richEnabled) {
        const ownsSubmission = () => mounted.current && latest.current.agentId === agentId && !latest.current.draftOnly && !latest.current.mutationBlocked
          && (kind === 'queue' ? latest.current.queueAllowed : latest.current.sendAllowed)
          && (!(hasAttachments || kind === 'queue') || !latest.current.pendingFirstInputContext)
          && currentDraft.text === submitted && ownsImageEdit() && imageDraft.parts === submittedParts;
        if (!await imageDraft.retain(ownsSubmission) || !ownsSubmission()) return;
      }
      if (content) await onSendMessageContent!(content, { ...(kind === 'queue' ? { delivery: 'next_turn' as const } : {}), imageDigests });
      else if (kind === 'queue') await action!(submitted.trim(), { delivery: 'next_turn' });
      else await action!(submitted.trim());
      if (currentDraft.text === submitted && (!richEnabled || ownsImageEdit() && imageDraft.parts === submittedParts)) {
        if (hasResources) resourceDraft.clear();
        if (richEnabled) imageDraft.setText(''); else { currentDraft.text = ''; if (currentAgent.current === agentId) onDraftChange?.(''); }
      }
      currentDraft.feedback = { kind: 'success', message: kind === 'send' ? t('composer.messageSent') : t('composer.messageQueued'), delivery: true };
      if (currentAgent.current === agentId) focusRequested.current = agentId;
    } catch (error) {
      if (content && ownsImageEdit() && error && typeof error === 'object' && 'code' in error && error.code === 'invalid_image_input') {
        imageDraft.rejectAttachments(content, t('composer.imageRejected'));
      }
      if (content && ownsImageEdit() && error && typeof error === 'object' && 'code' in error && error.code === 'invalid_resource_input') resourceDraft.reject(content, t('composer.resourceRejected'));
      currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : t('composer.actionFailed') };
    } finally {
      currentDraft.pending = undefined;
      if (mounted.current) refresh((value) => value + 1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement> | globalThis.KeyboardEvent): void {
    // A session that reads as read-only while its Host is offline can still be written to later.
    if (readOnly && !laterMode) return;
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
    if (event.key !== 'Enter') return;
    if (returnKeyAction({ coarsePointer: isCoarsePointer(), shift: event.shiftKey, composing: false, modifier: event.ctrlKey || event.metaKey }) !== 'send') return;
    event.preventDefault();
    void run('send');
  }

  // The "+" menu (I4): which items show and which can be used is one rule; here they get their words and actions.
  const showsSettings = Boolean(state?.agent) && !draftOnly && settings !== 'none';
  const menu = composerMenu({
    images: richEnabled && Boolean(imageDraftBinding || capabilities?.imageInput),
    resources: Boolean(capabilities?.resourceInput),
    resourceUpload: Boolean(onUploadResource) && resourceDraft.hydrated,
    target: agentId !== '' || draftOnly,
    ready, readOnly, busy, firstInputPending: pendingFirstInputContext,
    consoleCommands: consoleCommands.length > 0,
    queue: !canQueue ? 'none' : session.operations.queue_message.allowed ? 'allowed' : 'refused',
    draft: { content: hasContent, command: isCommand, skill: Boolean(selectedSkill), imagesReady: imageSendReady, waiting: waiting.items.length,
      sendable: Boolean(capabilities?.sendMessage) && Boolean(onSendMessage || onSendMessageContent) },
    settings: showsSettings,
  });
  const item = (id: string) => menu.find(entry => entry.id === id);
  const menuEntries: ComposerMenuEntry[] = [];
  const image = item('image'), resource = item('resource'), command = item('command'), queue = item('queue');
  if (image) menuEntries.push({ id: 'images', label: t('composer.addImages'), text: t('composer.image'), icon: <MenuIcon kind="image" />,
    ...(image.note ? { detail: t(image.note), title: t(image.note) } : {}), disabled: !image.enabled,
    run: () => { filePickerAgent.current = agentId; editorRef.current?.captureSelection(); fileInputRef.current?.click(); } });
  if (resource) menuEntries.push({ id: 'resources', label: t('composer.addResources'), text: t('composer.resource'), icon: <MenuIcon kind="file" />,
    ...(resource.note ? { detail: t(resource.note), title: t(resource.note) } : {}), disabled: !resource.enabled,
    run: () => { filePickerAgent.current = agentId; editorRef.current?.captureSelection(); resourceInputRef.current?.click(); } });
  if (command) menuEntries.push({ id: 'commands', label: t('composer.openCommands'), text: t('composer.command'), icon: <MenuIcon kind="command" />,
    disabled: !command.enabled, expanded: currentDraft.commandsOpen === true,
    run: () => { currentDraft.commandsOpen = !currentDraft.commandsOpen; currentDraft.commandsDismissed = false; refresh(value => value + 1); focusInput(); } });
  if (queue) menuEntries.push({ id: 'queue', label: pending === 'queue' ? t('composer.queueing') : t('composer.queue'), testId: 'queue-submit', icon: <MenuIcon kind="queue" />,
    ...(queue.note ? { detail: t(queue.note), title: t(queue.note) } : {}), disabled: !queue.enabled, run: () => void run('queue') });
  const setMenuView = (view: SessionControlView | undefined) => { currentDraft.view = view; refresh(value => value + 1); };
  // A draft-only stand-in reports no activity of its own (as the activity status reads it), so it never offers stop.
  const working = activitySession.activity === 'running', waitingForAnswer = activitySession.activity === 'waiting';
  const sendDisabled = !canSubmit || readOnly || busy || hasImages && pendingFirstInputContext || (selectedSkill ? nativeBusy || !onExecuteCommand
    : !hasContent || (!imageSendReady && !canWait) || (!isCommand && (capabilities?.sendMessage === false || (!onSendMessage && !onSendMessageContent && !canWait))));
  const sendIcon = pending === 'send' ? <span aria-hidden="true">…</span>
    : <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  const placeholder = ownershipReadOnly ? '' : forcedReadOnly ? readOnlyLabel ?? t('composer.recordingReadOnly') : readOnly && !laterMode ? readOnlyHint
    : blocked && !laterMode ? availability.words : agentId !== '' || draftOnly || laterMode ? recipient ? t('composer.placeholderTo', { name: recipient }) : t('composer.placeholder') : t('composer.noTarget');

  return <section ref={composerRef} className="agent-composer" aria-label={t('composer.region')} aria-busy={busy || richEnabled && !imageDraft.hydrated} data-control-readonly={ownershipReadOnly || undefined}>
    {richEnabled ? <input ref={fileInputRef} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (filePickerAgent.current === agentId) editorRef.current?.insertParts(addImageFiles(files)); }} /> : null}
    {capabilities?.resourceInput ? <input ref={resourceInputRef} type="file" hidden multiple aria-label={t('composer.chooseResources')} onChange={event => {
      const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = '';
      if (filePickerAgent.current !== agentId) return;
      try { editorRef.current?.insertParts(resourceDraft.add(files)); } catch (error) { currentDraft.feedback = { kind: 'error', message: error instanceof Error ? error.message : t('composer.resourceSelectionFailed') }; refresh(value => value + 1); }
    }} /> : null}
    <PendingSendQueue items={waiting.items} onCancel={waiting.cancel} onRetry={waiting.retry} />
    {/* What the composer says stands above the capsule, where the keyboard never covers it. */}
    {laterBlocked ? <p className="agent-composer-note" role="status">{laterBlocked}</p> : null}
    {waiting.items[0]?.phase === 'error' ? <p className="agent-composer-note" role="alert">
      {waiting.items[0].reason}{waiting.items[0].dispatched ? ` ${t('composer.checkConversation')}` : ''}
    </p> : null}
    {richEnabled && imageDraft.storageError ? <div className="agent-composer-note agent-draft-storage-status" role="status">
      <span>{imageDraft.storageError}</span>
      <button type="button" onClick={imageDraft.retryStorage} disabled={imageDraft.storageBusy} aria-label={t('composer.retryDraftStorage')}>{t('common.retry')}</button>
    </div> : null}
    {richEnabled && imageDraft.error ? <p className="agent-composer-note" role="alert">{imageDraft.error}</p> : null}
    {hasImages && pendingFirstInputContext && feedback?.message !== firstInputImageNotice ? <p className="agent-composer-note" role="status">{firstInputImageNotice}</p> : null}
    {hasResources ? <div className="agent-resource-draft-list" aria-label={t('composer.resourceUploads')}>{resourceDraft.items.map(({ id, label, record }) => <div className="agent-resource-draft" key={id}>
      <span><strong>[{label}]</strong> {record?.name ?? t('composer.fileUnavailable')} {record ? <small>{t('composer.bytes', { size: record.file.size.toLocaleString() })} · {record.status === 'uploading' ? t('composer.uploading', { percent: Math.round(record.progress * 100) }) : record.status === 'ready' ? t('composer.uploadReady') : record.status === 'failed' ? t('composer.uploadFailed') : t('composer.uploadPending')}</small> : null}</span>
      {record?.error ? <span role="alert">{record.error}</span> : null}
      {record?.status === 'failed' ? <button type="button" disabled={!ready || busy} onClick={() => resourceDraft.retry(id)}>{t('composer.retryResource', { label })}</button> : null}
      <button type="button" disabled={busy || readOnly} aria-label={t('composer.removeResource', { label })} onClick={() => imageDraft.setParts(imageDraft.parts.filter(part => part.type !== 'resource' || part.resourceId !== id))}>{t('common.remove')}</button>
    </div>)}</div> : null}
    {hasResources && (draftScope || imageDraftBinding?.scope) && !resourceDraft.storageError ? <p role="status" className="agent-composer-note">{imageDraft.storageSaved && !resourceDraft.storageBusy ? t('composer.resourceDraftSaved') : t('composer.resourceDraftSaving')}</p> : null}
    {hasResources && resourceDraft.storageError ? <p role="status" className="agent-composer-note">{resourceDraft.storageError}</p> : null}
    {hasResources && !ready ? <p role="status" className="agent-composer-note">{t('composer.resourcesWait')}</p> : null}
    {!ownershipReadOnly && !draftOnly && agentId === '' ? <p className="agent-composer-note">{t('composer.noTarget')}</p> : null}
    {feedback && !(feedback.delivery && state?.outgoingMessages !== undefined) ? commandRecovery != null ? <div className="agent-composer-note">{commandRecovery}</div>
      : <p className="agent-composer-note" role={feedback.kind === 'error' ? 'alert' : 'status'}>{feedback.message}</p> : null}
    <div className="agent-composer-input">
    {forcedReadOnly ? readOnlyNotice : null}
    {showCommands ? <div className="agent-command-menu">
      {directory.status === 'loading' && nativeCommandsEnabled ? <p role="status">{t('composer.loadingCommands')}</p> : null}
      {directory.status === 'failed' && nativeCommandsEnabled ? <><p role="alert">{directory.error}</p><button type="button" data-testid="retry-commands" onClick={directory.retry}>{t('common.retry')}</button></> : null}
      {commands.length === 0 ? <p>{capabilities?.commands !== true ? t('composer.noCommands') : t('composer.noMatchingCommands')}</p>
        : <div role="listbox" id={`${controlId}-commands`} aria-label={t('composer.nativeCommands')}>{commands.map((command, index) => <button
          type="button" role="option" aria-selected={index === commandIndex} id={`${controlId}-command-${index}`} key={command.id}
          onMouseDown={(event) => event.preventDefault()} onClick={() => chooseCommand(command)}>
          <strong>/{command.name}</strong><span className="agent-command-description" title={command.description}>{(command as ConsoleCommand).descriptionKey ? t((command as ConsoleCommand).descriptionKey!) : command.shortDescription || command.description}</span>
          {consoleCommands.some((local) => local.id === command.id) ? <small className="agent-command-kind">{t('composer.kindConsole')}</small>
            : command.kind !== 'command' ? <small className="agent-command-kind">{command.kind === 'skill' ? t('composer.kindSkill') : t('composer.kindPrompt')}</small> : null}
        </button>)}</div>}
    </div> : null}
    <div className="agent-composer-draft" hidden={hideDraft}>
    {firstInputContext ? <p className="agent-composer-note" role="status">
      {firstInputContext.state === 'pending' ? t('composer.historyPending')
        : firstInputContext.state === 'restoring' ? t('composer.historyChecking')
        : firstInputContext.state === 'unavailable' ? t('composer.historyUnavailable')
        : t('composer.historyUnconfirmed')}
      {firstInputContext.onRetry && ['unavailable', 'unknown', 'dispatching', 'accepted'].includes(firstInputContext.state) ? <> <button type="button" onClick={firstInputContext.onRetry}>{t('composer.checkAgain')}</button></> : null}
    </p> : null}
    {attachments}
    {selectedSkill ? <div className="agent-composer-attachments" aria-label={t('composer.selectedSkill')}>
      <span className="agent-skill-tag">
        <button type="button" aria-label={t('composer.viewSkill', { name: selectedSkill.name })} onClick={() => {
          if (onInspectCommand) onInspectCommand(selectedSkill);
          else { currentDraft.inspectedSkill = selectedSkill; refresh((value) => value + 1); }
        }}><span aria-hidden="true">⌘</span> <span>{selectedSkill.name}</span></button>
        <button type="button" aria-label={t('composer.removeSkill', { name: selectedSkill.name })} disabled={busy || readOnly} onClick={() => { currentDraft.selectedSkill = undefined; refresh((value) => value + 1); focusInput(); }}>×</button>
      </span>
      {nativeBusy ? <span className="agent-composer-note">{t('composer.skillAfterTurn')}</span> : null}
    </div> : null}
    <div className="agent-composer-capsule">
    {!ownershipReadOnly ? showsSettings && state?.agent ? <AgentSessionSettings entries={menuEntries} items={menu} sessionState={session} key={agentId} state={state} disabled={false} readOnly={forcedReadOnly} view={currentDraft.view} busy={busy}
        onView={setMenuView}
        onPendingChange={(value) => { currentDraft.settingPending = value; if (mounted.current) refresh((count) => count + 1); }}
        onSelect={onSetSessionSetting && !mutationBlocked ? async (id, value) => { if (latest.current.draftOnly || latest.current.mutationBlocked || latest.current.agentId !== agentId) return; await onSetSessionSetting(id, value); } : undefined} renderError={renderSessionSettingError}>{sessionControls}</AgentSessionSettings>
      : <div className="agent-session-controls"><ComposerMenu entries={menuEntries} open={currentDraft.view === 'actions'} onOpen={open => setMenuView(open ? 'actions' : undefined)} /></div> : null}
    <label htmlFor={`${controlId}-input`} className="agent-visually-hidden">{t('composer.message')}</label>
    {richEnabled ? <ComposerEditor key={editorIdentity} ref={editorRef} id={`${controlId}-input`} parts={imageDraft.parts} images={imageDraft.images} placeholder={placeholder} label={t('composer.message')}
      disabled={(blocked || agentId === '') && !draftOnly && !laterMode || readOnly && !laterMode || busy} onChange={parts => { imageDraft.setParts(parts); currentDraft.commandIndex = 0; currentDraft.commandsDismissed = false; currentDraft.feedback = undefined; }}
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
      enterKeyHint={isCoarsePointer() ? 'enter' : 'send'}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      disabled={!ownershipReadOnly && ((blocked || agentId === '') && !draftOnly && !laterMode || readOnly && !laterMode || busy)}
      readOnly={ownershipReadOnly}
      placeholder={placeholder}
      aria-describedby={`${controlId}-hint`}
      aria-controls={showCommands && commands.length > 0 ? `${controlId}-commands` : undefined}
      aria-activedescendant={showCommands && commands.length > 0 ? `${controlId}-command-${commandIndex}` : undefined}
    />}
    {!ownershipReadOnly ? <>
      <InterruptButton shown={working || waitingForAnswer || pending === 'command'}
        disabled={!canInterrupt || currentDraft.interruptPending === true || (pending !== undefined && pending !== 'command') || !onCancel}
        label={currentDraft.interruptPending ? t('composer.interrupting') : interruptRequested ? t('composer.interruptRequested') : t('composer.interrupt')}
        title={state?.agent?.capabilities.cancel ? t('composer.interruptTitle') : t('composer.interruptUnavailable')}
        onInterrupt={() => void run('cancel')} />
      {laterMode ? <button type="button" className="agent-composer-send" data-testid="prompt-submit" aria-label={pending === 'send' ? t('composer.sending') : sendLater!.label} title={laterBlocked ?? t('composer.sendLaterTitle', { label: sendLater!.label })}
        disabled={busy || !hasContent || !!laterBlocked} {...sendButtonPress}>{sendIcon}</button>
      : <button type="button" className="agent-composer-send" data-testid="prompt-submit" aria-label={pending === 'send' ? t('composer.sending') : t('composer.send')} title={hasImages && pendingFirstInputContext ? firstInputImageNotice : nativeBusy ? t('composer.sendTitleBusy') : t('composer.sendTitle')}
        disabled={sendDisabled} {...sendButtonPress}>{sendIcon}</button>}
    </> : null}
    </div>
    </div>
    {/* The activity is said on screen by the timeline's status line; assistive technology hears it here. */}
    {!ownershipReadOnly ? <div className="agent-visually-hidden"><AgentActivityStatus sessionState={activitySession} host={host} visible={activityVisible} state={draftOnly ? undefined : state} commandPending={pending === 'command'} /></div> : null}
    {hasImages ? <ImageUploadStatus parts={imageDraft.parts} images={imageDraft.images} connected={ready} onOpen={imageId => editorRef.current?.openImage(imageId)} /> : null}
    </div>
    <p id={`${controlId}-hint`} hidden={forcedReadOnly} className={`agent-composer-note${readOnly && !laterMode ? '' : ' agent-visually-hidden'}`}>{readOnly && !laterMode ? readOnlyHint : nativeBusy ? t('composer.hintBusy') : t('composer.hint')}</p>
    {!draftOnly && !onInspectCommand && currentDraft.inspectedSkill && state ? <AgentCommandDetails key={`${agentId}:${currentDraft.inspectedSkill.id}`}
      command={currentDraft.inspectedSkill} resources={state.resources} onRequestResource={onRequestResource}
      onResolveResource={onResolveResource} resourceScopeKey={JSON.stringify([agentId, currentDraft.inspectedSkill.id])}
      onClose={() => { currentDraft.inspectedSkill = undefined; refresh((value) => value + 1); }} /> : null}
  </section>;
}

/** The small line icons of the "+" menu's items. */
function MenuIcon({ kind }: { kind: 'image' | 'file' | 'command' | 'queue' }) {
  const path = kind === 'image' ? 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5zM4.5 16l4.5-4.5 4 4 2.5-2.5 4 4M15.5 8.5h.01'
    : kind === 'file' ? 'M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8L14 3.5zM14 3.5V8h4.5'
    : kind === 'command' ? 'M15 4 9 20'
    : 'M5 7h14M5 12h14M5 17h8';
  return <svg viewBox="0 0 24 24" width="18" height="18"><path d={path} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
