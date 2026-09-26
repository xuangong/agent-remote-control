import type { ImageUploadReceipt, MessagePart, ResourceResponseState } from '@orchardworks/agent-remote-protocol';
import type { AgentCommand, AgentCommandResult, AgentMessageOptions } from '@orchardworks/agent-remote-protocol';
import type {
  AgentInteractionResponse,
  ResourceBinding,
} from '@orchardworks/agent-remote-protocol';

import type { SessionTakeControlOptions } from '../client/session-control-extension.js';
export type { SessionTakeControlOptions } from '../client/session-control-extension.js';

export interface SessionViewActions {
  takeControl?(options?: SessionTakeControlOptions): Promise<void>;
  editPrompt?(entry: import('@orchardworks/agent-remote-protocol').ProjectedTimelineEntry): Promise<void>;
  loadOlder?(): void | Promise<void>;
  retryMessage?(id: string): Promise<void>;
  deleteMessage?(id: string): void;
  sendMessage?(text: string, options?: AgentMessageOptions): Promise<void>;
  sendMessageContent?(content: readonly MessagePart[], options?: AgentMessageOptions & { imageDigests?: Readonly<Record<string, string>> }): Promise<void>;
  uploadImage?(file: Blob, uploadId: string, options?: { signal?: AbortSignal; onProgress?(loaded: number, total: number): void }): Promise<NonNullable<ImageUploadReceipt['attachment']>>;
  steer?(text: string): Promise<void>;
  cancel?(): Promise<void>;
  respondToInteraction?(requestId: string, response: AgentInteractionResponse): Promise<void>;
  requestResource?(binding: ResourceBinding): Promise<void | ResourceResponseState>;
  resolveResource?(locator: string, sourceLocator?: string): Promise<ResourceBinding>;
  setPlanning?(active: boolean): Promise<void>;
  setSessionSetting?(id: string, value: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>;
  executeCommand?(id: string, args: string): Promise<AgentCommandResult>;
}

