import { randomUUID } from 'node:crypto';
import {
  decodeClientMessage, isSessionMutation, PROTOCOL_VERSION,
  type ClientMessage, type NativeSessionOwner, type ServerMessage, type SessionControlState,
} from '@orchardworks/agent-remote-protocol';

/** The refusals only the Relay's control decides; the Controller refuses what depends on the native runtime. */
const STALE_REVISION = 'Session access changed. Review its current state and retry.';
const NOT_CONTROLLING = 'This connection is read-only. Reconnect before operating this session.';

/**
 * What one browser stream may do to its session. It lives with the stream: a new stream starts read-only, `acquire` grants
 * control, and a refusal that a terminal holds the session revokes it. The owner is a fact about this stream only, cleared by
 * the next `acquire`: a terminal's exit is reported by no one, so nothing here may outlive the stream.
 */
interface Lease {
  revision: string;
  token?: string;
  nativeOwner?: NativeSessionOwner;
}

export interface StreamControlOptions {
  agentId: string;
  /** Writes a frame to the browser. */
  send(message: ServerMessage): void;
  /** Asks the Controller who holds the session natively; undefined when nobody does or it cannot say. */
  readNativeOwner(): Promise<NativeSessionOwner | undefined>;
  /** The grant was revoked: whatever the Controller still queued for this stream must not run, so a stream of its own ends. */
  revoked?(): void;
}

export interface StreamControl {
  /** Tells the browser what it may do; sent once, after the Snapshot. */
  announce(): void;
  /** Answers a control request, or refuses a mutation without a live grant. True when it did: the message goes no further. */
  admit(message: ClientMessage): boolean;
  /** The Controller refused a message of this stream with `code`; a refusal for a terminal's ownership revokes the grant. */
  controllerRefused(code: string, nativeOwner?: NativeSessionOwner): void;
  /**
   * A frame of the Controller session on a stream that passes through the Relay: says that this stream has session control
   * and announces the lease after the Snapshot. `forward` delivers the frame, as sent or as the Relay rewrote it.
   */
  controllerFrame(raw: string, forward: (raw: string) => void): void;
}

export function createStreamControl(options: StreamControlOptions): StreamControl {
  const { agentId, send } = options;
  const lease: Lease = { revision: randomUUID() };

  const state = (): SessionControlState => {
    const holding = lease.token !== undefined && lease.nativeOwner === undefined;
    return {
      agentId, revision: lease.revision, available: lease.nativeOwner === undefined, access: holding ? 'control' : 'read_only',
      ...(lease.nativeOwner ? { nativeOwner: { ...lease.nativeOwner } } : {}),
      ...(holding ? { token: lease.token! } : {}),
    };
  };
  const sendState = (requestId?: string): void => send({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { ...state(), ...(requestId === undefined ? {} : { requestId }) } });
  const refuse = (requestId: string | undefined, code: string, message: string): void => send({
    protocolVersion: PROTOCOL_VERSION, type: 'protocol_error', payload: { ...(requestId === undefined ? {} : { requestId }), code, message, recoverable: true },
  });

  /** Ends the grant. A new revision makes every request made against the old state stale. */
  function revoke(nativeOwner?: NativeSessionOwner): void {
    lease.token = undefined;
    lease.revision = randomUUID();
    lease.nativeOwner = nativeOwner && { ...nativeOwner };
    options.revoked?.();
  }

  let announced = false;
  return {
    announce() { announced = true; sendState(); },
    admit(message) {
      if (message.type === 'session_control_request') {
        const { requestId, revision } = message.payload;
        if (revision !== lease.revision) { refuse(requestId, 'session_control_changed', STALE_REVISION); return true; }
        lease.nativeOwner = undefined;
        lease.token ??= randomUUID();
        sendState(requestId);
        return true;
      }
      if (!isSessionMutation(message)) return false;
      if (lease.token === undefined || message.controlToken !== lease.token) {
        refuse(requestIdOf(message), 'session_read_only', NOT_CONTROLLING);
        return true;
      }
      return false;
    },
    controllerRefused(code, nativeOwner) {
      if (code !== 'native_session_owned') return;
      revoke(nativeOwner);
      // A refusal at delivery names no owner; the Controller's answer to opening the session again does.
      if (nativeOwner) { sendState(); return; }
      const revision = lease.revision;
      void options.readNativeOwner().catch(() => undefined).then(owner => {
        if (lease.revision !== revision) return;
        lease.nativeOwner = owner && { ...owner };
        sendState();
      });
    },
    controllerFrame(raw, forward) {
      // Most frames carry none of these types; only these are read.
      if (!raw.includes('"negotiated"') && !raw.includes('"agent_snapshot"') && !raw.includes('"native_session_owned"')) { forward(raw); return; }
      let frame: { type?: unknown; payload?: { code?: unknown } };
      try { frame = JSON.parse(raw); } catch { forward(raw); return; }
      if (frame.type === 'negotiated') forward(JSON.stringify({ ...frame, sessionControl: true }));
      else if (frame.type === 'agent_snapshot') { forward(raw); if (!announced) { announced = true; sendState(); } }
      else {
        forward(raw);
        if (frame.type === 'protocol_error' && typeof frame.payload?.code === 'string') this.controllerRefused(frame.payload.code);
      }
    },
  };
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
