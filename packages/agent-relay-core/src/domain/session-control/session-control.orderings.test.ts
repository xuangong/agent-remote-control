import { describe, expect, it } from 'vitest';
import { initialSessionControl, transition, viewOf, type SessionControlEvent, type SessionControlState } from './session-control.js';

// Every ordering of a small set of events, checked against the contract of the lease after every step: a broken ordering prints
// its exact sequence. A stream is one page; two pages are two streams of one session, whose events interleave in every order.

const owner = { kind: 'native_cli' as const, generation: '11111111-1111-4111-8111-111111111111' };
let fresh = 0;
const next = () => `fresh-${++fresh}`;
type Step = { name: string; event: (state: SessionControlState) => SessionControlEvent };
const steps: Step[] = [
  { name: 'snapshot', event: () => ({ type: 'snapshot' }) },
  { name: 'acquire', event: state => ({ type: 'acquire', requestId: 'r', revision: state.revision, fresh: next() }) },
  { name: 'acquire-stale', event: () => ({ type: 'acquire', requestId: 'r', revision: 'stale', fresh: next() }) },
  { name: 'send', event: state => ({ type: 'mutation', requestId: 's', ...(state.token ? { token: state.token } : {}) }) },
  { name: 'send-without-token', event: () => ({ type: 'mutation', requestId: 's', token: 'other' }) },
  { name: 'terminal-owns', event: () => ({ type: 'refused', code: 'native_session_owned', owner, fresh: next() }) },
  { name: 'refused-unnamed', event: () => ({ type: 'refused', code: 'native_session_owned', fresh: next() }) },
  { name: 'refused-other', event: () => ({ type: 'refused', code: 'host_unavailable', fresh: next() }) },
  { name: 'holder-owner', event: state => ({ type: 'holder', revision: state.revision, owner }) },
  { name: 'holder-none', event: state => ({ type: 'holder', revision: state.revision }) },
  { name: 'holder-stale', event: () => ({ type: 'holder', revision: 'stale', owner }) },
];

/** The clauses of the lease (header of session-control.ts) that one step must keep; an empty list when it kept them all. */
function broken(before: SessionControlState, event: SessionControlEvent, after: SessionControlState, reply: ReturnType<typeof transition>['reply']): string[] {
  const problems: string[] = [];
  const view = viewOf(after);
  if ((view.access === 'control') !== (after.token !== undefined && after.owner === undefined)) problems.push('control only while a token exists and no owner is recorded');
  if (view.available !== (after.owner === undefined)) problems.push('available exactly when no owner is recorded');
  if (event.type === 'acquire' && event.revision !== before.revision && (after !== before || reply.kind !== 'refuse')) problems.push('an acquire with another revision is refused and changes nothing');
  if (event.type === 'acquire' && event.revision === before.revision && (after.token === undefined || after.owner !== undefined || (before.token !== undefined && after.token !== before.token))) problems.push('an acquire grants control, clears the owner and keeps an issued token');
  if (event.type === 'mutation' && (reply.kind === 'pass') !== (before.token !== undefined && event.token === before.token)) problems.push('a mutation passes only with the live token');
  if (event.type === 'refused' && event.code === 'native_session_owned' && (after.token !== undefined || after.revision !== event.fresh || (event.owner ? after.owner?.generation !== event.owner.generation : reply.kind !== 'ask_holder'))) problems.push('a native refusal revokes the token, starts a revision and records or asks for the owner');
  if (event.type === 'refused' && event.code !== 'native_session_owned' && after !== before) problems.push('another refusal changes nothing');
  if (event.type === 'holder' && event.revision !== before.revision && after !== before) problems.push('a holder answer counts only for the revision it was asked under');
  return problems;
}

function run(names: readonly string[], state = initialSessionControl('first')): { state: SessionControlState; failures: string[] } {
  const failures: string[] = [];
  for (const [at, name] of names.entries()) {
    const event = steps.find(step => step.name === name)!.event(state);
    const { state: after, reply } = transition(state, event);
    for (const problem of broken(state, event, after, reply)) failures.push(`${names.slice(0, at + 1).join(' > ')}: ${problem}`);
    state = after;
  }
  return { state, failures };
}

function* sequences(length: number, alphabet: readonly string[]): Generator<string[]> {
  if (length === 0) { yield []; return; }
  for (const head of alphabet) for (const tail of sequences(length - 1, alphabet)) yield [head, ...tail];
}

describe('the control lease of one page, in every order of four events', () => {
  it('keeps its contract after every step', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const order of sequences(4, steps.map(step => step.name))) { failures.push(...run(order).failures); checked += 1; }
    expect(checked).toBe(steps.length ** 4);
    expect(failures.slice(0, 5)).toEqual([]);
  });
  it('lets the page send after an acquire, whatever came before', () => {
    const failures: string[] = [];
    for (const order of sequences(3, steps.map(step => step.name))) {
      const { state } = run([...order, 'acquire']);
      const reply = transition(state, steps.find(step => step.name === 'send')!.event(state)).reply;
      if (reply.kind !== 'pass') failures.push(`${[...order, 'acquire', 'send'].join(' > ')}: the send was refused`);
    }
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

describe('two pages on one session, their events interleaved in every order', () => {
  const page = ['snapshot', 'acquire', 'send'];
  function* interleavings(a: readonly string[], b: readonly string[]): Generator<Array<['A' | 'B', string]>> {
    if (!a.length) { yield b.map(name => ['B', name] as ['B', string]); return; }
    if (!b.length) { yield a.map(name => ['A', name] as ['A', string]); return; }
    for (const rest of interleavings(a.slice(1), b)) yield [['A', a[0]!], ...rest];
    for (const rest of interleavings(a, b.slice(1))) yield [['B', b[0]!], ...rest];
  }
  it('lets every page send, and a terminal that refuses one page leaves the other page its control', () => {
    const failures: string[] = [];
    let orders = 0;
    // Each page: open, acquire, send; a terminal's refusal reaches page A at any point of the order.
    for (const order of interleavings(page, [...page])) {
      for (let refusedAt = 0; refusedAt <= order.length; refusedAt += 1) {
        orders += 1;
        const states = { A: initialSessionControl('a'), B: initialSessionControl('b') };
        const passed = { A: false, B: false };
        const trace: string[] = [];
        const apply = (stream: 'A' | 'B', name: string) => {
          trace.push(`${stream}:${name}`);
          const { state, reply } = transition(states[stream], steps.find(step => step.name === name)!.event(states[stream]));
          states[stream] = state;
          if (name === 'send' && reply.kind === 'pass') passed[stream] = true;
        };
        order.forEach(([stream, name], at) => { if (at === refusedAt) apply('A', 'terminal-owns'); apply(stream, name); });
        if (refusedAt === order.length) apply('A', 'terminal-owns');
        if (!passed.B) failures.push(`${trace.join(' > ')}: page B could not send`);
        // Page A sends after its acquire unless the terminal took the session before that send; then a new acquire gives it back.
        if (!passed.A) { apply('A', 'acquire'); apply('A', 'send'); if (viewOf(states.A).access !== 'control') failures.push(`${trace.join(' > ')}: page A could not take control back`); }
      }
    }
    expect(orders).toBe(20 * 7);
    expect(failures.slice(0, 5)).toEqual([]);
  });
});
