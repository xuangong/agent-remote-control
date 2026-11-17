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
  /** The grant was revoked: whatever the Controller still queued for this stream must not run. */
  revoked?(): void;
}

export interface StreamControl {
  /** Tells the browser what it may do; sent once, after the Snapshot. */
  announce(): void;
  /** Answers a control request, or refuses a mutation without a live grant. True when it did: the message goes no further. */
  admit(message: ClientMessage): boolean;
  /** The Controller refused a message of this stream; a refusal for a terminal's ownership revokes the grant. */
  controllerRefused(code: string, nativeOwner?: NativeSessionOwner): void;
  /** A frame of the Controller session on a stream that passes through the Relay: marks the stream as controlled and announces it after the Snapshot. */
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
      options.revoked?.();
      if (nativeOwner) { sendState(); return; }
      // A refusal at delivery names no owner; asking the Controller to open the session again does.
      const current = revision;
      void options.readNativeOwner().catch(() => undefined).then(found => {
        if (revision !== current) return;
        owner = found && { ...found };
        sendState();
      });
    },
    controllerFrame(raw, forward) {
      // Most frames carry none of these types; only these are read.
      if (!raw.includes('"negotiated"') && !raw.includes('"agent_snapshot"') && !raw.includes('"native_session_owned"')) { forward(raw); return; }
      let frame: { type?: unknown; payload?: { code?: unknown } };
      try { frame = JSON.parse(raw); } catch { forward(raw); return; }
      if (frame.type === 'negotiated') { forward(JSON.stringify({ ...frame, sessionControl: true })); return; }
      forward(raw);
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

/** What a raw browser frame decodes to when the Relay may answer it itself: negotiation, a control request or a mutation. */
export function relayMessageOf(raw: string): ClientMessage | undefined {
  let type: unknown;
  try { type = JSON.parse(raw)?.type; } catch { return undefined; }
  if (typeof type !== 'string' || (type !== 'negotiate' && type !== 'session_control_request' && !isSessionMutation({ type }))) return undefined;
  const decoded = decodeClientMessage(raw);
  return decoded.status === 'ok' ? decoded.value : undefined;
}
