import { createHash } from 'node:crypto';
import { validateSessionSetting, validateCommandDirectory, type AgentCommandResult } from '@borgee/agent-provider-sdk';
import { redactInteractionRequest, redactInteractionResponse, validateInteractionResponse } from '@borgee/agent-provider-sdk';
import type {
  AgentInteractionResponse,
  AgentMessageOptions,
  AgentPersistenceHandle,
  AgentProviderAdapter,
  AgentProviderDescriptor,
  AgentSessionConfig,
  AgentSession,
  AgentStreamEvent,
  ProviderObservation,
} from '@borgee/agent-provider-sdk';
import {
  PROTOCOL_VERSION,
  type AgentCommand,
  type AgentSnapshot,
  type HistoryPage,
  type ResourceResponse,
} from '@borgee/agent-remote-protocol';

import type { AgentManagerEvent } from './agent-manager-events.js';
import { discoverTimelineLocators, normalizeFileLocator } from './resources/markdown-locators.js';
import { ResourceIngestor } from './resources/resource-ingestor.js';
import { InMemoryResourceStore, type ResourceStore } from './resources/resource-store.js';
import { projectTimelinePage, type TimelinePageRequest } from './timeline-projector.js';
import { TimelineStore } from './timeline-store.js';

export interface AgentManagerAttachOptions {
  agentId: string;
  provider: AgentProviderDescriptor;
  session: AgentSession;
  epoch: string;
  clock?: () => Date;
  resourceStore?: ResourceStore;
}

export interface AgentManagerCreateOptions {
  agentId: string;
  adapter: AgentProviderAdapter;
  config: AgentSessionConfig;
  epoch: string;
  clock?: () => Date;
  resourceStore?: ResourceStore;
}

export interface AgentManagerResumeOptions {
  agentId: string;
  adapter: AgentProviderAdapter;
  handle: AgentPersistenceHandle;
  epoch: string;
  clock?: () => Date;
  resourceStore?: ResourceStore;
}

export type AgentManagerListener = (event: AgentManagerEvent) => void;

export type InteractionResponseErrorCode = 'stale_interaction' | 'invalid_interaction_response';

export class InteractionResponseError extends Error {
  constructor(readonly code: InteractionResponseErrorCode, message: string) {
    super(message);
    this.name = 'InteractionResponseError';
  }
}

export class UnsupportedAgentCapabilityError extends Error {
  constructor(readonly capability: 'send_message' | 'queue_message' | 'steer' | 'cancel' | 'set_planning' | 'set_session_setting' | 'list_commands' | 'execute_command') {
    super(`Provider does not support ${capability}.`);
    this.name = 'UnsupportedAgentCapabilityError';
  }
}

export class AgentBusyError extends Error {
  constructor(message = 'Planning can only change while the Agent is idle with no pending interactions.') {
    super(message);
    this.name = 'AgentBusyError';
  }
}

export class AgentManager {
  readonly ready: Promise<void>;
  readonly settled: Promise<void>;

  private readonly listeners = new Set<AgentManagerListener>();
  private timeline: TimelineStore;
  private readonly state: AgentSnapshot;
  private readonly bufferedLive: ProviderObservation[] = [];
  private readonly seenProviderRecords = new Map<string, Set<number | null>>();
  private readonly claimedInteractionIds = new Set<string>();
  private statusBeforeInteraction: AgentSnapshot['payload']['status'] | undefined;
  private resolveReady!: () => void;
  private rejectReady!: (error: unknown) => void;
  private readySettled = false;
  private boundarySeen = false;
  private closed = false;
  private commandTail: Promise<void> = Promise.resolve();
  private pendingCommandExecutions = 0;
  private commandResources = new Map<string, { commandId: string; locator: string }>();

  private constructor(
    readonly agentId: string,
    readonly provider: AgentProviderDescriptor,
    private readonly session: AgentSession,
    epoch: string,
    createdAt: string,
    runtimeInfo: Awaited<ReturnType<AgentSession['runtimeInfo']>>,
    private readonly clock: () => Date,
    private readonly resourceIngestor: ResourceIngestor,
  ) {
    this.timeline = new TimelineStore(epoch);
    this.state = {
      protocolVersion: PROTOCOL_VERSION,
      type: 'agent_snapshot',
      payload: {
        id: agentId,
        providerId: provider.providerId,
        ...(runtimeInfo.cwd === undefined ? {} : { cwd: runtimeInfo.cwd }),
        ...(runtimeInfo.model === undefined ? {} : { model: runtimeInfo.model }),
        createdAt,
        updatedAt: createdAt,
        status: runtimeInfo.status,
        activeTurn: null,
        capabilities: structuredClone(session.capabilities),
        pendingInteractions: [],
        runtimeInfo: structuredClone(runtimeInfo),
        ...(runtimeInfo.persistence === undefined ? {} : { persistence: structuredClone(runtimeInfo.persistence) }),
      },
    };
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.settled = this.consume();
    void this.settled.catch(() => undefined);
  }

  static async attach(options: AgentManagerAttachOptions): Promise<AgentManager> {
    const runtimeInfo = await options.session.runtimeInfo();
    if (runtimeInfo.providerId !== options.provider.providerId) {
      throw new Error('Provider runtime identity does not match its descriptor.');
    }
    return new AgentManager(
      options.agentId,
      options.provider,
      options.session,
      options.epoch,
      (options.clock ?? (() => new Date()))().toISOString(),
      runtimeInfo,
      options.clock ?? (() => new Date()),
      new ResourceIngestor({ store: options.resourceStore ?? new InMemoryResourceStore() }),
    );
  }

  static async create(options: AgentManagerCreateOptions): Promise<AgentManager> {
    const session = await options.adapter.createSession(options.config);
    if (options.config.planning === true && (session.capabilities.planning !== true || !session.setPlanning)) {
      await session.dispose().catch(() => undefined);
      throw new UnsupportedAgentCapabilityError('set_planning');
    }
    return AgentManager.attachOwnedSession(options, session);
  }

  static async resume(options: AgentManagerResumeOptions): Promise<AgentManager> {
    const session = await options.adapter.resumeSession(options.handle);
    return AgentManager.attachOwnedSession(options, session);
  }

  private static async attachOwnedSession(
    options: Omit<AgentManagerCreateOptions, 'config'> | Omit<AgentManagerResumeOptions, 'handle'>,
    session: AgentSession,
  ): Promise<AgentManager> {
    let manager: AgentManager | undefined;
    try {
      manager = await AgentManager.attach({
        agentId: options.agentId,
        provider: options.adapter.descriptor,
        session,
        epoch: options.epoch,
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.resourceStore === undefined ? {} : { resourceStore: options.resourceStore }),
      });
      await manager.ready;
      return manager;
    } catch (error) {
      if (manager) await manager.close().catch(() => undefined);
      else await session.dispose().catch(() => undefined);
      throw error;
    }
  }

  snapshot(): AgentSnapshot {
    return structuredClone(this.state);
  }

  fetchTimeline(request: TimelinePageRequest): HistoryPage {
    if (request.agentId !== this.agentId) throw new Error('Timeline request identifies a different Agent.');
    return projectTimelinePage(this.timeline, request);
  }

  subscribe(listener: AgentManagerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  replaceTimeline(epoch: string): void {
    if (epoch === this.timeline.epoch) return;
    this.timeline = new TimelineStore(epoch);
    this.seenProviderRecords.clear();
    this.emit({ type: 'timeline_replacement', agentId: this.agentId, epoch });
  }

  async sendMessage(text: string, options?: AgentMessageOptions): Promise<void> {
    if (this.pendingCommandExecutions > 0) throw new AgentBusyError('The Agent is busy executing a native command.');
    return this.serializeCommand(async () => {
      if (!this.session.capabilities.sendMessage) throw new UnsupportedAgentCapabilityError('send_message');
      if (options?.delivery === 'next_turn' && this.session.capabilities.queueMessage !== true) throw new UnsupportedAgentCapabilityError('queue_message');
      if (options === undefined) await this.session.sendMessage(text);
      else await this.session.sendMessage(text, options);
    });
  }

  async setPlanning(active: boolean): Promise<void> {
    return this.serializeCommand(async () => {
      if (this.session.capabilities.planning !== true || !this.session.setPlanning) {
        throw new UnsupportedAgentCapabilityError('set_planning');
      }
      const state = this.state.payload;
      if (state.status !== 'idle' || state.activeTurn !== null || state.pendingInteractions.length > 0) throw new AgentBusyError();
      await this.session.setPlanning(active);
      const runtimeInfo = await this.session.runtimeInfo();
      this.applyStateEvent({ type: 'runtime_updated', provider: this.provider.providerId, runtimeInfo }, this.clock().toISOString());
    });
  }

  async setSessionSetting(id: string, value: string): Promise<void> {
    return this.serializeCommand(async () => {
      if (this.session.capabilities.sessionSettings !== true || !this.session.setSessionSetting) {
        throw new UnsupportedAgentCapabilityError('set_session_setting');
      }
      const state = this.state.payload;
      if (state.status !== 'idle' || state.activeTurn !== null || state.pendingInteractions.length > 0) throw new AgentBusyError();
      validateSessionSetting((await this.session.runtimeInfo()).settings, id, value);
      await this.session.setSessionSetting(id, value);
      const runtimeInfo = await this.session.runtimeInfo();
      this.applyStateEvent({ type: 'runtime_updated', provider: this.provider.providerId, runtimeInfo }, this.clock().toISOString());
    });
  }

  async listCommands(): Promise<AgentCommand[]> {
    if (this.closed) throw new Error('Agent session is closed.');
    if (this.session.capabilities.commands !== true || !this.session.listCommands) throw new UnsupportedAgentCapabilityError('list_commands');
    const resources = new Map<string, { commandId: string; locator: string }>();
    const commands = validateCommandDirectory(await this.session.listCommands()).map(({ documentation, ...command }): AgentCommand => {
      if (!documentation || !this.session.capabilities.readResource || !this.session.readResource || !normalizeFileLocator(documentation)) return command;
      const resourceId = `command:${createHash('sha256').update(JSON.stringify([this.agentId, command.id, documentation])).digest('hex')}`;
      resources.set(resourceId, { commandId: command.id, locator: documentation });
      return { ...command, documentation: { locator: documentation, resourceId, status: 'pending' } };
    });
    this.commandResources = resources;
    return commands;
  }

  async executeCommand(id: string, args: string): Promise<AgentCommandResult> {
    this.pendingCommandExecutions += 1;
    try {
      return await this.serializeCommand(async () => {
        if (this.session.capabilities.commands !== true || !this.session.executeCommand) throw new UnsupportedAgentCapabilityError('execute_command');
        const commands = await this.listCommands();
        if (!commands.some((command) => command.id === id)) throw new Error('Native command is no longer available. Refresh the command list.');
        const result = await this.session.executeCommand(id, args);
        const runtimeInfo = await this.session.runtimeInfo();
        this.applyStateEvent({ type: 'runtime_updated', provider: this.provider.providerId, runtimeInfo }, this.clock().toISOString());
        return result;
      });
    } finally { this.pendingCommandExecutions -= 1; }
  }

  private serializeCommand<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(() => {
      if (this.closed) throw new Error('Agent session is closed.');
      return operation();
    });
    this.commandTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async steer(text: string): Promise<void> {
    if (!this.session.capabilities.steer || !this.session.steer) {
      throw new UnsupportedAgentCapabilityError('steer');
    }
    await this.session.steer(text);
  }

  async cancel(): Promise<void> {
    if (!this.session.capabilities.cancel || !this.session.cancel) {
      throw new UnsupportedAgentCapabilityError('cancel');
    }
    await this.session.cancel();
  }

  async respondToInteraction(requestId: string, response: AgentInteractionResponse): Promise<void> {
    const pending = this.state.payload.pendingInteractions.find((request) => request.requestId === requestId);
    if (!pending || this.claimedInteractionIds.has(requestId)) {
      throw new InteractionResponseError('stale_interaction', 'Interaction request is no longer pending.');
    }
    try {
      validateInteractionResponse(pending, response);
    } catch {
      throw new InteractionResponseError(
        'invalid_interaction_response',
        'Interaction response does not satisfy the pending request.',
      );
    }
    this.claimedInteractionIds.add(requestId);
    try {
      await this.session.respondToInteraction(requestId, response);
    } catch (error) {
      this.claimedInteractionIds.delete(requestId);
      throw error;
    }
  }

  async readResource(requestId: string, resourceId: string): Promise<ResourceResponse> {
    const document = this.commandResources.get(resourceId);
    if (document && !this.closed) {
      const commands = await this.listCommands();
      if (commands.some((command) => command.id === document.commandId && command.documentation?.resourceId === resourceId)) {
        const acquisition = this.resourceIngestor.acquire({ agentId: this.agentId, locator: document.locator,
          reader: (locator) => this.session.readResource!(locator) });
        if (acquisition) {
          const binding = await acquisition.settled;
          const response = this.resourceIngestor.readResponse(requestId, this.agentId, binding.resourceId);
          return { ...response, payload: { ...response.payload, resourceId } };
        }
      }
    }
    return this.resourceIngestor.readResponse(requestId, this.agentId, resourceId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.resolveReadiness();
    this.listeners.clear();
    try {
      await this.session.dispose();
    } finally {
      await this.settled.catch(() => undefined);
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const item of this.session.observe()) {
        if (this.closed) break;
        if (item.type === 'history_boundary') {
          if (this.boundarySeen) throw new Error('Provider emitted more than one history boundary.');
          this.boundarySeen = true;
          for (const observation of this.bufferedLive.splice(0)) await this.applyObservation(observation);
          this.resolveReadiness();
          continue;
        }
        if (!this.boundarySeen && item.delivery === 'live') {
          this.bufferedLive.push(item);
          continue;
        }
        if (this.boundarySeen && item.delivery === 'history') {
          throw new Error('Provider emitted history after its history boundary.');
        }
        await this.applyObservation(item);
      }
      if (!this.closed) {
        if (!this.boundarySeen) {
          throw new Error('Provider observation stream ended before history readiness.');
        }
        throw new Error('Provider observation stream ended unexpectedly.');
      }
    } catch (error) {
      if (!this.readySettled) {
        this.rejectReadiness(error);
        throw error;
      }
      if (!this.closed) this.applyObservationFailure(error);
    }
  }

  private resolveReadiness(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private rejectReadiness(error: unknown): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady(error);
  }

  private applyObservationFailure(error: unknown): void {
    const timestamp = this.clock().toISOString();
    this.state.payload.runtimeInfo = {
      ...this.state.payload.runtimeInfo,
      status: 'failed',
    };
    const event: Extract<AgentStreamEvent, { type: 'turn_failed' }> = {
      type: 'turn_failed',
      provider: this.provider.providerId,
      error: 'Provider observation stream failed.',
      code: 'provider_observation_failed',
      diagnostic: error instanceof Error ? error.message : String(error),
    };
    this.applyStateEvent(event, timestamp);
    this.emitStream(event, timestamp);
  }

  private async applyObservation(observation: ProviderObservation): Promise<void> {
    if (this.isDuplicate(observation)) return;
    let event = observation.event;
    if (event.type === 'timeline' && event.item.type === 'interaction') {
      event = { ...event, item: { ...event.item, request: redactInteractionRequest(event.item.request), response: redactInteractionResponse(event.item.request, event.item.response) } };
    } else if (event.type === 'interaction_requested') {
      event = { ...event, request: redactInteractionRequest(event.request) };
    } else if (event.type === 'interaction_resolved') {
      const resolvedRequestId = event.requestId;
      const request = this.state.payload.pendingInteractions.find(({ requestId }) => requestId === resolvedRequestId);
      // Orphan resolutions have no trusted sensitivity metadata, so retain no answer values.
      event = { ...event, response: redactInteractionResponse(request ?? { kind: 'question', requestId: event.requestId, questions: [] }, event.response) };
    }
    if (event.type === 'timeline') {
      const timeline = this.timeline;
      const result = timeline.append({
        providerId: event.provider,
        sourceKey: observation.sourceKey,
        ...(observation.nativeRevision === undefined ? {} : { nativeRevision: observation.nativeRevision }),
        occurredAt: observation.occurredAt,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        item: event.item,
      });
      if (result.status === 'duplicate') return;
      this.remember(observation);
      const acquisitions = discoverTimelineLocators(event.item)
        .map(({ locator, normalizedLocator }) => {
          const readLocator = providerReadLocator(observation, normalizedLocator);
          return this.resourceIngestor.acquire({
            agentId: this.agentId,
            locator,
            ...(readLocator === undefined ? {} : { readLocator }),
            ...(this.session.capabilities.readResource && this.session.readResource
              ? { reader: (target: string) => this.session.readResource!(target) }
              : {}),
          });
        })
        .filter((acquisition) => acquisition !== undefined);
      const resources = acquisitions.map(({ binding }) => binding);
      const row = resources.length === 0 ? result.row : timeline.bindResources(result.row.seq, resources);
      acquisitions.forEach((acquisition, index) => {
        void acquisition.settled.then((binding) => {
          const previous = resources[index];
          resources[index] = binding;
          timeline.bindResources(result.row.seq, resources);
          if (previous && previous.resourceId !== binding.resourceId) {
            this.emit({
              type: 'timeline_resource_binding_replaced',
              agentId: this.agentId,
              epoch: result.row.epoch,
              seq: result.row.seq,
              previous,
              replacement: binding,
            });
          }
          this.emit({
            type: 'resource_update',
            agentId: this.agentId,
            resourceId: binding.resourceId,
            state: this.resourceIngestor.readState(this.agentId, binding.resourceId),
          });
        }).catch(() => undefined);
      });
      this.emitStream(event, row.timestamp, row);
      return;
    }
    const timestamp = new Date(observation.occurredAt).toISOString();
    if (event.type === 'interaction_resolved') {
      const request = this.state.payload.pendingInteractions.find(({ requestId, kind }) => requestId === event.requestId && kind === event.response.kind);
      if (request) {
        const completed: Extract<AgentStreamEvent, { type: 'timeline' }> = {
          type: 'timeline', provider: event.provider,
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          item: { type: 'interaction', request: structuredClone(request), response: structuredClone(event.response) },
        };
        const result = this.timeline.append({
          providerId: event.provider, sourceKey: observation.sourceKey, occurredAt: observation.occurredAt,
          ...(observation.nativeRevision === undefined ? {} : { nativeRevision: observation.nativeRevision }),
          ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
          item: completed.item,
        });
        if (result.status === 'appended') this.emitStream(completed, result.row.timestamp, result.row);
      }
    }
    this.applyStateEvent(event, timestamp);
    this.remember(observation);
    this.emitStream(event, timestamp);
    if (event.type === 'interaction_requested') {
      this.emit({
        type: 'interaction_requested',
        agentId: this.agentId,
        request: structuredClone(event.request),
      });
    } else if (event.type === 'interaction_resolved') {
      this.emit({
        type: 'interaction_resolved',
        agentId: this.agentId,
        requestId: event.requestId,
        response: structuredClone(event.response),
      });
    }
  }

  private applyStateEvent(event: Exclude<AgentStreamEvent, { type: 'timeline' }>, timestamp: string): void {
    const state = this.state.payload;
    state.updatedAt = timestamp;
    switch (event.type) {
      case 'thread_started':
        if (state.status === 'starting') state.status = 'idle';
        break;
      case 'turn_started':
        state.status = 'running';
        state.activeTurn = event.turnId ? { turnId: event.turnId, startedAt: timestamp } : null;
        break;
      case 'turn_completed':
        state.status = 'idle';
        state.activeTurn = null;
        if (event.usage) state.lastUsage = structuredClone(event.usage);
        break;
      case 'turn_failed':
        state.status = 'failed';
        state.activeTurn = null;
        state.lastError = event.error;
        break;
      case 'turn_canceled':
        state.status = 'idle';
        state.activeTurn = null;
        break;
      case 'usage_updated':
        state.lastUsage = structuredClone(event.usage);
        break;
      case 'runtime_updated':
        state.runtimeInfo = structuredClone(event.runtimeInfo);
        state.status = event.runtimeInfo.status;
        if (event.runtimeInfo.cwd !== undefined) state.cwd = event.runtimeInfo.cwd;
        if (event.runtimeInfo.model !== undefined) state.model = event.runtimeInfo.model;
        if (event.runtimeInfo.persistence !== undefined) state.persistence = structuredClone(event.runtimeInfo.persistence);
        break;
      case 'interaction_requested': {
        const index = state.pendingInteractions.findIndex(({ requestId }) => requestId === event.request.requestId);
        if (index === -1) {
          if (state.pendingInteractions.length === 0) this.statusBeforeInteraction = state.status;
          state.pendingInteractions.push(structuredClone(event.request));
        }
        else state.pendingInteractions[index] = structuredClone(event.request);
        state.status = 'waiting';
        break;
      }
      case 'interaction_resolved': {
        this.claimedInteractionIds.delete(event.requestId);
        const index = state.pendingInteractions.findIndex(({ requestId }) => requestId === event.requestId);
        if (index !== -1) state.pendingInteractions.splice(index, 1);
        if (state.pendingInteractions.length === 0) {
          if (state.status === 'waiting') {
            state.status = this.statusBeforeInteraction ?? (state.activeTurn ? 'running' : 'idle');
          }
          this.statusBeforeInteraction = undefined;
        }
        break;
      }
    }
    this.emit({ type: 'agent_state', agentId: this.agentId, snapshot: this.snapshot() });
  }

  private isDuplicate(observation: ProviderObservation): boolean {
    return this.seenProviderRecords.get(observation.sourceKey)?.has(observation.nativeRevision ?? null) ?? false;
  }

  private remember(observation: ProviderObservation): void {
    const revision = observation.nativeRevision ?? null;
    const revisions = this.seenProviderRecords.get(observation.sourceKey);
    if (revisions) revisions.add(revision);
    else this.seenProviderRecords.set(observation.sourceKey, new Set([revision]));
  }

  private emitStream(
    event: AgentStreamEvent,
    timestamp: string,
    row?: Extract<AgentManagerEvent, { type: 'agent_stream' }>['row'],
  ): void {
    this.emit({
      type: 'agent_stream',
      agentId: this.agentId,
      event,
      timestamp,
      ...(row === undefined ? {} : { row }),
    });
  }

  private emit(event: AgentManagerEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(event));
      } catch {
        this.listeners.delete(listener);
      }
    }
  }
}

function providerReadLocator(observation: ProviderObservation, normalizedLocator: string): string | undefined {
  for (const reference of observation.resourceReferences ?? []) {
    if (!reference.readLocator || normalizeFileLocator(reference.locator) !== normalizedLocator) continue;
    return reference.readLocator;
  }
  return undefined;
}
