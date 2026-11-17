import { randomUUID } from 'node:crypto';
import {
  decodeClientMessage, isSessionMutation, PROTOCOL_VERSION,
  type ClientMessage, type NativeSessionOwner, type ServerMessage,
} from '@orchardworks/agent-remote-protocol';

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
 * What one browser stream may do to its session. A new stream is read-only, `acquire` grants control, and a refusal that a
 * terminal holds the session revokes it and shows the owner. The owner is a fact about this stream only, cleared by its next
 * `acquire`: no one reports a terminal's exit, so nothing here outlives the stream.
 */
export function createStreamControl(options: StreamControlOptions): StreamControl {
  const { agentId, send } = options;
  let revision = randomUUID();
  let token: string | undefined;
  let owner: NativeSessionOwner | undefined;
  let announced = false;

  const sendState = (requestId?: string): void => {
    const holding = token !== undefined && owner === undefined;
    send({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
      agentId, revision, available: owner === undefined, access: holding ? 'control' : 'read_only',
      ...(owner ? { nativeOwner: { ...owner } } : {}), ...(holding ? { token } : {}), ...(requestId === undefined ? {} : { requestId }),
    } });
  };
  const refuse = (requestId: string | undefined, code: string, message: string): void => send({
    protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { ...(requestId === undefined ? {} : { requestId }), code, message, recoverable: true },
  });
  const announce = (): void => { announced = true; sendState(); };

  const control: StreamControl = {
    announce,
    admit(message) {
      if (message.type === 'session_control_request') {
        const { requestId } = message.payload;
        if (message.payload.revision !== revision) refuse(requestId, 'session_control_changed', 'Session access changed. Review its current state and retry.');
        else { owner = undefined; token ??= randomUUID(); sendState(requestId); }
        return true;
      }
      if (!isSessionMutation(message) || (token !== undefined && message.controlToken === token)) return false;
      refuse(requestIdOf(message), 'session_read_only', 'This connection is read-only. Reconnect before operating this session.');
      return true;
    },
    controllerRefused(code, nativeOwner) {
      if (code !== 'native_session_owned') return;
      token = undefined;
      revision = randomUUID();
      owner = nativeOwner && { ...nativeOwner };
      if (nativeOwner) { sendState(); return; }
      // A refusal at delivery names no owner; asking the Controller to open the session again does.
      const current = revision;
      void control.holder().catch(() => undefined).then(found => {
        if (revision !== current) return;
        owner = found && { ...found };
        sendState();
      });
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
      if (frame.type === 'agent_snapshot' && !announced) announce();
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
