// The props of the conversation surface (`SessionWorkbench`): what a view gives the shared session renderer.
import type { ComponentProps, ReactNode } from 'react';
import type { ImageDraftBinding, ImageDraftRecipient } from '@orchardworks/agent-client-web/browser';
import type { AgentReplicaState, RemoteSessionState, RemoteSessionStatus, SessionAttribution, SessionDescription, SessionFacts, SessionHandoffState } from '@orchardworks/agent-client';
import type { AgentCommand, AgentCommandResult } from '@orchardworks/agent-remote-protocol';
import type { AgentChildSessionView, AgentComposer, AgentTimelineProps, QuestionDraft, SessionLinkResolver, SessionTodoPanelProps, SessionViewActions, TimelineEntrySelection, TimelineReadingPositions } from '@orchardworks/agent-client-web/react';
import type { ProcessAssistant } from './useProcessMode.js';
import type { TileSession } from './assistant/TileHeader.js';
import type { AssistantRef } from './assistant/AssistantDetails.js';
import type { TraceEntryRequest } from '../kernel/trace-model.js';

export type LabWorkbenchActions = SessionViewActions;

/**
 * `inline`: the conversation's own heading. `toolbar`: a compact view whose heading tools sit in the timeline's tools.
 * `assistant`: the assistant view's top bar is the heading, and this conversation puts its search there. `tile`: a Window tile,
 * whose heading is the assistant's (avatar, name, the session's title and a sentence), its details opening over the window.
 */
export type ConversationHeadingMode = 'inline' | 'toolbar' | 'assistant' | 'tile';

export interface SessionWorkbenchProps {
  entrySelection?: TimelineEntrySelection;
  /** Who answers in this conversation: the live line's name and the avatar at the foot of the answers. */
  /** Who answers, and the session whose latest reply a tile's sentence says. */
  assistant?: AgentTimelineProps['assistant'] & { readonly session?: TileSession };
  /** What the assistant's details show beyond this conversation's own process mode, settings and files: who it is, where it works, its sessions. */
  details?: Partial<AssistantRef>;
  /** The session's title as words; a tile shows it beside the assistant's name when it differs from the name. */
  conversationTitle?: string;
  /**
   * The session shown, `<providerId>/<nativeSessionId>`. Not its Host: a conversation painted from this device before its
   * Window has loaded does not know the Host yet.
   */
  nativeSession?: string;
  /** The bot this conversation is, when it is one: the view options choose its own process mode. */
  processAssistant?: ProcessAssistant;
  /** The session's Host as the Relay last said: an offline Host is said once, and the composer stays enabled. */
  host?: SessionFacts['host'];
  /** Said in place of Opening session while the conversation cannot load yet, for example because its Host is offline. */
  loadingNotice?: { title: string; detail: string };
  /** This is a stand-in for a session whose Window is still loading: plain messages typed into it wait for the pane that replaces it. */
  opening?: boolean;
  /** The view could not open its session and says so with a Retry: a message waiting for the session says Not sent. */
  openFailed?: boolean;
  /** Sends from a draft-only composer whose Host is offline: the message waits for the Host. */
  sendLater?: ComponentProps<typeof AgentComposer>['sendLater'];
  /** Content above this conversation's own entries once its oldest page is loaded: a bot's earlier sessions after a handoff. */
  timelineStart?: ReactNode; timelineEnd?: ReactNode; sessionDescription?: SessionDescription; onNavigateAttribution?(attribution: SessionAttribution): void | Promise<void>; todo?: SessionTodoPanelProps; sessionState?: RemoteSessionState; handoff?: SessionHandoffState; readOnly?: boolean; draftOnly?: boolean; mutationBlocked?: boolean; pendingFirstInputContext?: ComponentProps<typeof AgentComposer>['pendingFirstInputContext']; onPendingInputChange?(count: number): void; workspaceLink?: ReactNode; readingPositions?: TimelineReadingPositions; draftScope?: string; imageDraftBinding?: ImageDraftBinding; imageRecipient?: ImageDraftRecipient; isAuthenticationError?(error: unknown): boolean; authenticationNotice?: ReactNode; renderSessionSettingError?(error: unknown): ReactNode; renderCommandError?(error: unknown): ReactNode; onInspectEntry?: (key: string) => void; revealEntry?: TraceEntryRequest; composerContext?: ReactNode; composerNotice?: ReactNode; composerStatus?: ReactNode; headingContext?: ReactNode; nativeTakeover?: ReactNode; consoleCommands?: readonly (AgentCommand & { aliases?: readonly string[] })[]; onExecuteConsoleCommand?(id: string, args: string): Promise<AgentCommandResult>; state?: AgentReplicaState; sessionStatus: RemoteSessionStatus; attachingAgentId?: string; actions: LabWorkbenchActions; conversationPath?: ReactNode; headingStart?: ReactNode;
  headingMode?: ConversationHeadingMode; sessionManager?: ReactNode; resolveSessionLink?: SessionLinkResolver; childrenFor?: (nativeSessionId: string) => readonly AgentChildSessionView[]; onOpenChildSession?: (child: AgentChildSessionView) => void | Promise<void>; visible?: boolean; draftSessionKey?: string; messageDraft?: string; onMessageDraftChange?(text: string): void; questionDrafts?: Readonly<Record<string, QuestionDraft>>; onQuestionDraftChange?: (requestId: string, draft: QuestionDraft) => void;
}
