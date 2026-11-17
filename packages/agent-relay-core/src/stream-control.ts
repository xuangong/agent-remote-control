import { randomUUID } from 'node:crypto';
import {
  decodeClientMessage, isSessionMutation, PROTOCOL_VERSION,
  type ClientMessage, type NativeSessionOwner, type ServerMessage,
} from '@orchardworks/agent-remote-protocol';
import {
  initialSessionControl, transition, viewOf, type SessionControlEvent,
} from './domain/session-control/session-control.js';

export interface StreamControlOptions {
  agentId: string;
  send(message: ServerMessage): void;
  /** Asks the Controller who holds the session natively; undefined when nobody does or it cannot say. */
  readNativeOwner(): Promise<NativeSessionOwner | undefined>;
}

export interface StreamControl {
  /** Tells the browser what it may do; sent once, after the Snapshot. */
  announce(): void;
  /** Answers a control request, or refuses a mutation without a live grant. True when it did: the message goes no further. */
  admit(message: ClientMessage): boolean;
  /** `admit` for a raw browser frame; a control request or mutation that does not decode is refused here, never forwarded. */
  admitRaw(raw: string): boolean;
  /** Who holds the session natively, asked of the Controller; rejects with the refusal when it cannot say. */
  holder(): Promise<NativeSessionOwner | undefined>;
  /** The Controller refused a message of this stream; a refusal for a terminal's ownership revokes the grant. */
  controllerRefused(code: string, nativeOwner?: NativeSessionOwner): void;
  /** A frame of the Controller session on a stream that passes through the Relay: announces the grant after the Snapshot and reads refusals. */
  controllerFrame(raw: string, forward: (raw: string) => void): void;
}

/**
 * What one browser stream may do to its session: the shell of the lease table in `domain/session-control`. It decodes
 * browser frames, mints ids, asks the Controller who holds the session, and sends what the table replies.
 */
export function createStreamControl(options: StreamControlOptions): StreamControl {
  const { agentId, send } = options;
  let state = initialSessionControl(randomUUID());

  const sendState = (requestId?: string): void => {
    send({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, ...viewOf(state), ...(requestId === undefined ? {} : { requestId }) } });
  };
  const refuse = (requestId: string | undefined, code: string, message: string): void => send({
    protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { ...(requestId === undefined ? {} : { requestId }), code, message, recoverable: true },
  });
  /** Applies an event; true when the table answered the message itself, so it goes no further. */
  const apply = (event: SessionControlEvent): boolean => {
    const next = transition(state, event);
    state = next.state;
    const { reply } = next;
    switch (reply.kind) {
      case 'state': sendState(reply.requestId); return true;
      case 'refuse': refuse(reply.requestId, reply.code, reply.message); return true;
      case 'ask_holder': {
        void control.holder().catch(() => undefined).then(found => { apply({ type: 'holder', revision: reply.revision, ...(found ? { owner: found } : {}) }); });
        return false;
      }
      case 'pass': return false;
      case 'none': return false;
    }
  };

  const control: StreamControl = {
    announce: () => { apply({ type: 'announce' }); },
    admit(message) {
      if (message.type === 'session_control_request') {
        return apply({ type: 'acquire', requestId: message.payload.requestId, revision: message.payload.revision, fresh: randomUUID() });
      }
      if (!isSessionMutation(message)) return false;
      const requestId = requestIdOf(message);
      return apply({ type: 'mutation', ...(requestId === undefined ? {} : { requestId }), ...(message.controlToken === undefined ? {} : { token: message.controlToken }) });
    },
    controllerRefused(code, nativeOwner) {
      apply({ type: 'refused', code, ...(nativeOwner ? { owner: nativeOwner } : {}), fresh: randomUUID() });
    },
    admitRaw(raw) {
      let frame: { type?: unknown; payload?: { requestId?: unknown } };
      try { frame = JSON.parse(raw); } catch { return false; }
      const { type } = frame;
      if (typeof type !== 'string' || (type !== 'session_control_request' && !isSessionMutation({ type }))) return false;
      const decoded = decodeClientMessage(raw);
      if (decoded.status === 'ok') return control.admit(decoded.value);
      refuse(typeof frame.payload?.requestId === 'string' ? frame.payload.requestId : undefined, 'invalid_shape', 'Client message was rejected.');
      return true;
    },
    holder: () => options.readNativeOwner(),
    controllerFrame(raw, forward) {
      forward(raw);
      // Most frames carry neither of these; only these are read.
      if (!raw.includes('"agent_snapshot"') && !raw.includes('"native_session_owned"')) return;
      let frame: { type?: unknown; payload?: { code?: unknown } };
      try { frame = JSON.parse(raw); } catch { return; }
      if (frame.type === 'agent_snapshot') apply({ type: 'snapshot' });
      if (frame.type === 'protocol_error' && typeof frame.payload?.code === 'string') control.controllerRefused(frame.payload.code);
    },
  };
  return control;
}

/** The identifier a reply to this message carries: the request id, or the submission id of an interaction answer. */
export function requestIdOf(message: ClientMessage): string | undefined {
  if (message.type === 'interaction_response') return message.payload.submissionId;
  const payload = (message as unknown as { payload?: { requestId?: unknown } }).payload;
  return typeof payload?.requestId === 'string' ? payload.requestId : undefined;
}
