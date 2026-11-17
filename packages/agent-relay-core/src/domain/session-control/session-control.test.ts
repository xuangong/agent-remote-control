import { describe, expect, it } from 'vitest';

import { initialSessionControl, transition, viewOf, type SessionControlEvent, type SessionControlReply, type SessionControlState } from './session-control.js';

const owner = { kind: 'native_cli' as const, generation: 'native-1' };
const fresh = (revision = 'r1'): SessionControlState => ({ revision, announced: true });
const holding = (token = 't1', revision = 'r1'): SessionControlState => ({ revision, token, announced: true });
const owned = (revision = 'r2'): SessionControlState => ({ revision, owner, announced: true });
const changed = (requestId: string): SessionControlReply => ({ kind: 'refuse', requestId, code: 'session_control_changed', message: expect.any(String) });
const readOnly = (requestId?: string): SessionControlReply => ({ kind: 'refuse', ...(requestId === undefined ? {} : { requestId }), code: 'session_read_only', message: expect.any(String) });

interface Row { name: string; state: SessionControlState; event: SessionControlEvent; next: SessionControlState; reply: SessionControlReply }

const rows: Row[] = [
  // announcing
  { name: 'announce sends the first state and marks it announced', state: initialSessionControl('r1'), event: { type: 'announce' }, next: fresh(), reply: { kind: 'state' } },
  { name: 'announce sends again when asked again', state: fresh(), event: { type: 'announce' }, next: fresh(), reply: { kind: 'state' } },
  { name: 'the first Snapshot announces', state: initialSessionControl('r1'), event: { type: 'snapshot' }, next: fresh(), reply: { kind: 'state' } },
  { name: 'a later Snapshot says nothing', state: fresh(), event: { type: 'snapshot' }, next: fresh(), reply: { kind: 'none' } },
  // acquiring
  { name: 'acquire with the current revision issues the token and answers the request', state: fresh(), event: { type: 'acquire', requestId: 'q1', revision: 'r1', fresh: 't1' }, next: holding(), reply: { kind: 'state', requestId: 'q1' } },
  { name: 'acquire again keeps the first token', state: holding('t1'), event: { type: 'acquire', requestId: 'q2', revision: 'r1', fresh: 't2' }, next: holding('t1'), reply: { kind: 'state', requestId: 'q2' } },
  { name: 'acquire with another revision is refused as changed and changes nothing', state: fresh(), event: { type: 'acquire', requestId: 'q1', revision: 'old', fresh: 't1' }, next: fresh(), reply: changed('q1') },
  { name: 'a refused acquire does not take away a held token', state: holding(), event: { type: 'acquire', requestId: 'q1', revision: 'old', fresh: 't2' }, next: holding(), reply: changed('q1') },
  { name: 'acquire clears the native owner and issues a token', state: owned('r2'), event: { type: 'acquire', requestId: 'q1', revision: 'r2', fresh: 't1' }, next: holding('t1', 'r2'), reply: { kind: 'state', requestId: 'q1' } },
  { name: 'acquire on the revision before the owner appeared is refused', state: owned('r2'), event: { type: 'acquire', requestId: 'q1', revision: 'r1', fresh: 't1' }, next: owned('r2'), reply: changed('q1') },
  // mutations
  { name: 'a mutation with the live token passes', state: holding('t1'), event: { type: 'mutation', requestId: 'm1', token: 't1' }, next: holding('t1'), reply: { kind: 'pass' } },
  { name: 'a mutation before any acquire is refused as read-only', state: fresh(), event: { type: 'mutation', requestId: 'm1' }, next: fresh(), reply: readOnly('m1') },
  { name: 'a mutation with a token that was never issued is refused while no token is held', state: fresh(), event: { type: 'mutation', requestId: 'm1', token: 'guess' }, next: fresh(), reply: readOnly('m1') },
  { name: 'a mutation with another token is refused', state: holding('t1'), event: { type: 'mutation', requestId: 'm1', token: 't2' }, next: holding('t1'), reply: readOnly('m1') },
  { name: 'a mutation without a token is refused while a token is held', state: holding('t1'), event: { type: 'mutation', requestId: 'm1' }, next: holding('t1'), reply: readOnly('m1') },
  { name: 'a refused mutation without a request id carries none', state: fresh(), event: { type: 'mutation' }, next: fresh(), reply: readOnly() },
  { name: 'the revoked token no longer passes', state: owned('r2'), event: { type: 'mutation', requestId: 'm1', token: 't1' }, next: owned('r2'), reply: readOnly('m1') },
  // refusals at delivery
  { name: 'a refusal that is not about ownership changes nothing', state: holding(), event: { type: 'refused', code: 'invalid_shape', fresh: 'r2' }, next: holding(), reply: { kind: 'none' } },
  { name: 'an ownership refusal that names the owner revokes the token and records it', state: holding('t1', 'r1'), event: { type: 'refused', code: 'native_session_owned', owner, fresh: 'r2' }, next: owned('r2'), reply: { kind: 'state' } },
  { name: 'an ownership refusal on a read-only stream records the owner too', state: fresh(), event: { type: 'refused', code: 'native_session_owned', owner, fresh: 'r2' }, next: owned('r2'), reply: { kind: 'state' } },
  { name: 'an ownership refusal that names no owner revokes the token and asks who holds the session', state: holding('t1', 'r1'), event: { type: 'refused', code: 'native_session_owned', fresh: 'r2' }, next: fresh('r2'), reply: { kind: 'ask_holder', revision: 'r2' } },
  { name: 'a second ownership refusal starts another revision', state: owned('r2'), event: { type: 'refused', code: 'native_session_owned', owner: { kind: 'controller', generation: 'c-1' }, fresh: 'r3' }, next: { revision: 'r3', owner: { kind: 'controller', generation: 'c-1' }, announced: true }, reply: { kind: 'state' } },
  // the answer to "who holds it"
  { name: 'the holder of the asked revision is recorded', state: fresh('r2'), event: { type: 'holder', revision: 'r2', owner }, next: owned('r2'), reply: { kind: 'state' } },
  { name: 'no holder for the asked revision leaves the session available and says so', state: fresh('r2'), event: { type: 'holder', revision: 'r2' }, next: fresh('r2'), reply: { kind: 'state' } },
  { name: 'a holder for an older revision is dropped', state: fresh('r3'), event: { type: 'holder', revision: 'r2', owner }, next: fresh('r3'), reply: { kind: 'none' } },
  { name: 'a holder for an older revision does not undo an acquire that came first', state: holding('t1', 'r2'), event: { type: 'holder', revision: 'r1', owner }, next: holding('t1', 'r2'), reply: { kind: 'none' } },
];

describe('the lease transition table', () => {
  it.each(rows.map(row => [row.name, row] as const))('%s', (_name, { state, event, next, reply }) => {
    const result = transition(state, event);
    expect(result.state).toEqual(next);
    expect(result.reply).toEqual(reply);
  });

  it('reads its arguments and writes nothing to them', () => {
    for (const { state, event } of rows) {
      const before = JSON.stringify([state, event]);
      transition(state, event);
      expect(JSON.stringify([state, event])).toBe(before);
    }
  });

  it('does not share the owner object with the event or the state', () => {
    const named = { ...owner };
    const next = transition(fresh(), { type: 'refused', code: 'native_session_owned', owner: named, fresh: 'r2' }).state;
    expect(next.owner).toEqual(owner);
    expect(next.owner).not.toBe(named);
  });
});

describe('the view a browser is told', () => {
  it('is read-only and available for a new stream', () => {
    expect(viewOf(initialSessionControl('r1'))).toEqual({ revision: 'r1', available: true, access: 'read_only' });
  });

  it('is control with the token once acquired', () => {
    expect(viewOf(holding('t1'))).toEqual({ revision: 'r1', available: true, access: 'control', token: 't1' });
  });

  it('is read-only, unavailable and names the owner while a terminal holds the session, whatever token is left', () => {
    expect(viewOf(owned('r2'))).toEqual({ revision: 'r2', available: false, access: 'read_only', nativeOwner: owner });
    expect(viewOf({ ...holding('t1', 'r2'), owner })).toEqual({ revision: 'r2', available: false, access: 'read_only', nativeOwner: owner });
  });
});
