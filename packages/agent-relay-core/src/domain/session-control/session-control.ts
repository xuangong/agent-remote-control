import type { NativeSessionOwner } from '@orchardworks/agent-remote-protocol';

/**
 * The control lease of one browser stream: what the stream may do to its session. A pure transition table: it reads a
 * state and an event and returns the next state and a reply as data. It owns no socket, clock or id source; the caller
 * supplies a fresh unique id (`fresh`) with the events that can mint a token or a revision.
 *
 * Contract (seam S3, `docs/current/agent-remote/seams.md`):
 * - A new stream is read-only: no token. Its first state is announced once, after the Controller's Snapshot.
 * - `acquire` with the current revision grants control: the native owner is cleared and the token is issued once and
 *   kept by later acquires. An `acquire` with another revision is refused with `session_control_changed` and changes nothing.
 * - A mutation passes only with the stream's live token; otherwise it is refused with `session_read_only`.
 * - A refusal at delivery with the code `native_session_owned` revokes the token, starts a new revision, and records the
 *   owner when the refusal names one; without one the caller asks the Controller who holds the session (`ask_holder`)
 *   and answers with a `holder` event, which counts only for the revision it was asked under. Any other refusal changes nothing.
 * - The owner is a fact about this stream only: the next successful `acquire` clears it.
 * - `viewOf` is the state a browser is told: control only while a token exists and no owner is recorded; `available` is
 *   true exactly when no owner is recorded.
 */
export interface SessionControlState {
  readonly revision: string;
  readonly token?: string;
  readonly owner?: NativeSessionOwner;
  /** The first state has been sent. */
  readonly announced: boolean;
}

export type SessionControlEvent =
  /** Send the state now, whether or not it was announced. */
  | { type: 'announce' }
  /** The Controller's Snapshot reached the stream: announce the first time only. */
  | { type: 'snapshot' }
  | { type: 'acquire'; requestId: string; revision: string; fresh: string }
  /** A session mutation of the browser, with the token it carried. */
  | { type: 'mutation'; requestId?: string; token?: string }
  | { type: 'refused'; code: string; owner?: NativeSessionOwner; fresh: string }
  | { type: 'holder'; revision: string; owner?: NativeSessionOwner };

export type SessionControlReply =
  | { kind: 'none' }
  /** Send the browser its state (see `viewOf`), answering `requestId` when there is one. */
  | { kind: 'state'; requestId?: string }
  | { kind: 'refuse'; requestId?: string; code: 'session_control_changed' | 'session_read_only'; message: string }
  /** The mutation holds the token: it goes on to the Controller. */
  | { kind: 'pass' }
  /** Ask the Controller who holds the session; answer with a `holder` event carrying this revision. */
  | { kind: 'ask_holder'; revision: string };

export interface SessionControlView {
  readonly revision: string;
  readonly available: boolean;
  readonly access: 'control' | 'read_only';
  readonly nativeOwner?: NativeSessionOwner;
  readonly token?: string;
}

export function initialSessionControl(revision: string): SessionControlState {
  return { revision, announced: false };
}

export function viewOf(state: SessionControlState): SessionControlView {
  const holding = state.token !== undefined && state.owner === undefined;
  return {
    revision: state.revision, available: state.owner === undefined, access: holding ? 'control' : 'read_only',
    ...(state.owner ? { nativeOwner: { ...state.owner } } : {}), ...(holding ? { token: state.token } : {}),
  };
}

export function transition(state: SessionControlState, event: SessionControlEvent): { state: SessionControlState; reply: SessionControlReply } {
  switch (event.type) {
    case 'announce':
      return { state: { ...state, announced: true }, reply: { kind: 'state' } };
    case 'snapshot':
      return state.announced ? { state, reply: { kind: 'none' } } : { state: { ...state, announced: true }, reply: { kind: 'state' } };
    case 'acquire': {
      if (event.revision !== state.revision) {
        return { state, reply: { kind: 'refuse', requestId: event.requestId, code: 'session_control_changed', message: 'Session access changed. Review its current state and retry.' } };
      }
      const { owner: _cleared, ...rest } = state;
      return { state: { ...rest, token: state.token ?? event.fresh }, reply: { kind: 'state', requestId: event.requestId } };
    }
    case 'mutation':
      if (state.token !== undefined && event.token === state.token) return { state, reply: { kind: 'pass' } };
      return { state, reply: { kind: 'refuse', ...(event.requestId === undefined ? {} : { requestId: event.requestId }), code: 'session_read_only', message: 'This connection is read-only. Reconnect before operating this session.' } };
    case 'refused': {
      if (event.code !== 'native_session_owned') return { state, reply: { kind: 'none' } };
      const { token: _revoked, owner: _previous, ...rest } = state;
      if (event.owner) return { state: { ...rest, revision: event.fresh, owner: { ...event.owner } }, reply: { kind: 'state' } };
      return { state: { ...rest, revision: event.fresh }, reply: { kind: 'ask_holder', revision: event.fresh } };
    }
    case 'holder': {
      if (event.revision !== state.revision) return { state, reply: { kind: 'none' } };
      const { owner: _previous, ...rest } = state;
      return { state: event.owner ? { ...rest, owner: { ...event.owner } } : rest, reply: { kind: 'state' } };
    }
  }
}
