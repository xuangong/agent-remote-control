import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { AgentOperationRejectedError, type AgentSession, type AgentInputAcceptance, type AgentInputPart, type AgentMessageOptions } from '@orchardworks/agent-provider-sdk';
import { nativeSessionRefKey, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { SessionWireOperation } from '@orchardworks/agent-remote-relay';
import { SessionSuccessionContextStore, SessionSuccessionInputDispatcher } from './session-succession-context.js';

const mutations = new Set(['sendMessage', 'sendMessageContent', 'steer', 'cancel', 'respondToInteraction', 'setPlanning', 'setSessionSetting', 'executeCommand']);
interface AdmittedOperation { operationId: string; operation: SessionWireOperation }
interface RoleDestination { roleId: string; roleRevision: number }

/** Host-owned native dispatch boundary shared by browser, HTTP and TPM operations. */
export class SessionSuccessionBoundary {
  private readonly context = new AsyncLocalStorage<AdmittedOperation>();
  private readonly dispatcher: SessionSuccessionInputDispatcher;
  private readonly inFlight = new Map<string, number>();
  constructor(private readonly contexts: SessionSuccessionContextStore,
    private readonly assertAdmission: (target: NativeSessionRef) => void,
    private readonly resolveRole: (target: NativeSessionRef) => RoleDestination | undefined) {
    this.dispatcher = new SessionSuccessionInputDispatcher(contexts);
  }
  run<T>(operation: SessionWireOperation, scope: string, work: () => Promise<T>): Promise<T> {
    const operationId = createHash('sha256').update(JSON.stringify([scope, operation.operationId])).digest('hex');
    return this.context.run({ operationId, operation }, work);
  }
  pending(target: NativeSessionRef): number { return this.inFlight.get(nativeSessionRefKey(target)) ?? 0; }
  private validate(target: NativeSessionRef): void {
    try { this.assertAdmission(target); }
    catch (error) { throw new AgentOperationRejectedError('succession_admission_closed', error instanceof Error ? error.message : 'Session handoff admission is closed.'); }
  }
  wrap(target: NativeSessionRef, session: AgentSession): AgentSession {
    const address = structuredClone(target), boundary = this;
    return new Proxy(session, { get(native, property) {
      const value = Reflect.get(native, property, native);
      if (typeof value !== 'function') return value;
      if (!mutations.has(String(property))) return value.bind(native);
      return async (...args: unknown[]) => {
        boundary.validate(address);
        const key = nativeSessionRefKey(address);
        boundary.inFlight.set(key, boundary.pending(address) + 1);
        try {
          if (property === 'sendMessage') return await boundary.send(address, args[0] as string, undefined, args[1] as AgentMessageOptions | undefined,
            (text, _parts, options) => options === undefined ? native.sendMessage(text) : native.sendMessage(text, options));
          if (property === 'sendMessageContent') {
            const parts = args[0] as readonly AgentInputPart[];
            return await boundary.send(address, parts.filter(part => part.type === 'text').map(part => part.text).join(''), parts, args[1] as AgentMessageOptions | undefined,
              (_text, content, options) => native.sendMessageContent!(content!, options));
          }
          const attachment = boundary.contexts.forTarget(address);
          if ((property === 'executeCommand' || property === 'steer') && attachment && attachment.state !== 'materialized') {
            throw new AgentOperationRejectedError('succession_context_pending', 'Send a message to deliver the pending handoff context before executing commands.');
          }
          boundary.validate(address);
          return await Reflect.apply(value, native, args);
        } finally {
          const count = boundary.pending(address) - 1;
          if (count) boundary.inFlight.set(key, count); else boundary.inFlight.delete(key);
        }
      };
    } });
  }
  private async send(target: NativeSessionRef, text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined,
    send: (text: string, parts: readonly AgentInputPart[] | undefined, options: AgentMessageOptions | undefined) => Promise<AgentInputAcceptance | void>): Promise<AgentInputAcceptance | void> {
    const attachment = this.contexts.forTarget(target);
    if (!attachment) { this.validate(target); return send(text, parts, options); }
    const admitted = this.context.getStore();
    if (!admitted) throw new AgentOperationRejectedError('succession_operation_identity_required', 'An admitted operation identity is required for this successor.');
    const role = this.resolveRole(target);
    if (!role || role.roleId !== attachment.roleId || role.roleRevision !== attachment.roleRevision) {
      throw new AgentOperationRejectedError('succession_not_committed', 'This candidate has not been committed as the current primary session.');
    }
    const contentIdentity = createHash('sha256').update(JSON.stringify([parts ?? null, options ?? null])).digest('hex');
    const prior = this.contexts.delivery(admitted.operationId);
    if (attachment.state === 'materialized' && !prior) { this.validate(target); return send(text, parts, options); }
    let result: AgentInputAcceptance | void = undefined, rejected: unknown;
    const delivery = await this.dispatcher.dispatch({ ...role, operationId: admitted.operationId, target, text, contentIdentity },
      async () => { this.validate(target); }, async (input, prefix) => {
        try {
          this.validate(target);
          result = await send(input.text, parts ? [...(prefix ? [{type: 'text' as const, text: prefix}] : []), ...parts] : undefined, options);
          return { outcome: 'accepted', ...(result ? { inputAcceptance: result } : {}) };
        } catch (error) {
          if (!(error instanceof AgentOperationRejectedError)) throw error;
          rejected = error; return { outcome: 'rejected' };
        }
      });
    if (rejected) throw rejected;
    if (delivery.state === 'unknown' || delivery.state === 'dispatching') throw new Error('The first handoff input has an unresolved delivery outcome. Reconcile native history before sending again.');
    if (delivery.state === 'rejected') throw new AgentOperationRejectedError('operation_rejected', 'This first input was rejected. Use a new operation identity after correcting its cause.');
    return delivery.inputAcceptance;
  }
}
