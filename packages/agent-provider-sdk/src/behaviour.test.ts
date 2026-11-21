import { describe, expect, it } from 'vitest';

import {
  AgentRuntimeError, AgentSessionInUseError, resolveAgentProviderBehaviour, UNDECLARED_PROVIDER_BEHAVIOUR, validAgentProviderBehaviour,
  type AgentProviderBehaviour,
} from './index.js';

const declared: AgentProviderBehaviour = {
  concurrency: { model: 'shared_clients', probe: 'lock_file', othersVisible: 'live', unloadAfterLastClientMs: 70_000 },
  reread: { order: 'live', paging: 'turns', withoutAttach: false, cost: 'page' },
  resume: { cost: 'subscription', deadlineMs: 90_000 },
  input: { identity: 'echoes_client_id', whileBusy: 'steer' },
  limits: { signal: 'event' },
  failures: { runtime: ['native_resume_timeout', 'native_usage_limited'], inUse: ['writer_elsewhere'] },
  liveOnly: ['interaction', 'todo'],
  verifiedVersion: '0.171.0',
};

/** One field of the declaration set to a value the contract does not name. */
const misdeclared: Array<[string, (behaviour: Record<string, any>) => void]> = [
  ['an unknown concurrency model', value => { value.concurrency.model = 'exclusive'; }],
  ['an unknown probe', value => { value.concurrency.probe = 'socket'; }],
  ['an unknown visibility of other clients', value => { value.concurrency.othersVisible = 'sometimes'; }],
  ['an unload time of zero', value => { value.concurrency.unloadAfterLastClientMs = 0; }],
  ['a fractional unload time', value => { value.concurrency.unloadAfterLastClientMs = 1.5; }],
  ['an unknown reread order', value => { value.reread.order = 'random'; }],
  ['an unknown paging', value => { value.reread.paging = 'bytes'; }],
  ['a read without attach that is not a boolean', value => { value.reread.withoutAttach = 'yes'; }],
  ['an unknown read cost', value => { value.reread.cost = 'free'; }],
  ['an unknown resume cost', value => { value.resume.cost = 'cheap'; }],
  ['a missing resume deadline', value => { delete value.resume.deadlineMs; }],
  ['a negative resume deadline', value => { value.resume.deadlineMs = -1; }],
  ['an unknown input identity', value => { value.input.identity = 'hash'; }],
  ['an unknown busy rule', value => { value.input.whileBusy = 'drop'; }],
  ['an unknown limit signal', value => { value.limits.signal = 'header'; }],
  ['a runtime failure the SDK does not type', value => { value.failures.runtime = ['native_runtime_failed']; }],
  ['an in-use reason the SDK does not name', value => { value.failures.inUse = ['busy']; }],
  ['an unknown live-only kind', value => { value.liveOnly = ['tool']; }],
  ['an empty verified version', value => { value.verifiedVersion = ''; }],
  ['no limits at all', value => { delete value.limits; }],
];

describe('the behaviour a provider declares', () => {
  it('is taken as declared when every field holds a value the contract names (C1, C2)', () => {
    expect(validAgentProviderBehaviour(declared)).toBe(true);
    expect(resolveAgentProviderBehaviour({ behaviour: declared })).toBe(declared);
    const { verifiedVersion: _version, ...unversioned } = declared;
    const { unloadAfterLastClientMs: _unload, ...concurrency } = declared.concurrency;
    expect(resolveAgentProviderBehaviour({ behaviour: { ...unversioned, concurrency } })).toEqual({ ...unversioned, concurrency });
  });

  it.each(misdeclared)('is replaced whole by the undeclared behaviour for %s (C2)', (_label, change) => {
    const behaviour = structuredClone(declared) as Record<string, any>;
    change(behaviour);
    expect(validAgentProviderBehaviour(behaviour)).toBe(false);
    expect(resolveAgentProviderBehaviour({ behaviour: behaviour as AgentProviderBehaviour })).toBe(UNDECLARED_PROVIDER_BEHAVIOUR);
  });

  it('is the undeclared behaviour for an adapter that declares none (C2)', () => {
    expect(resolveAgentProviderBehaviour({})).toBe(UNDECLARED_PROVIDER_BEHAVIOUR);
    expect(resolveAgentProviderBehaviour({ behaviour: null as unknown as AgentProviderBehaviour })).toBe(UNDECLARED_PROVIDER_BEHAVIOUR);
  });

  it("assumes what the Controller assumed before declarations: the only client, live order, a process's resume, nothing typed (C3)", () => {
    expect(validAgentProviderBehaviour(UNDECLARED_PROVIDER_BEHAVIOUR)).toBe(true);
    expect(UNDECLARED_PROVIDER_BEHAVIOUR).toEqual({
      concurrency: { model: 'none', probe: 'none', othersVisible: 'never' },
      reread: { order: 'live', paging: 'none', withoutAttach: false, cost: 'whole_session' },
      resume: { cost: 'process', deadlineMs: 30_000 },
      input: { identity: 'none', whileBusy: 'refuse' },
      limits: { signal: 'none' },
      failures: { runtime: [], inUse: [] },
      liveOnly: [],
    });
    expect(Object.isFrozen(UNDECLARED_PROVIDER_BEHAVIOUR.concurrency)).toBe(true);
  });
});

describe('the typed failures of a native runtime', () => {
  it('say why a session is in use and when to try again', () => {
    const refused = new AgentSessionInUseError('Another process writes this session.', { reason: 'writer_elsewhere', retryAfterMs: 70_000 });
    expect(refused).toMatchObject({ name: 'AgentSessionInUseError', message: 'Another process writes this session.', reason: 'writer_elsewhere', retryAfterMs: 70_000 });
    expect(new AgentSessionInUseError('A turn runs.', { reason: 'turn_running' }).retryAfterMs).toBeUndefined();
  });

  it('keep no reason or wait they cannot vouch for', () => {
    expect(new AgentSessionInUseError('In use.')).toMatchObject({ reason: undefined, retryAfterMs: undefined });
    expect(new AgentSessionInUseError('In use.', { reason: 'busy' as never, retryAfterMs: -1 })).toMatchObject({ reason: undefined, retryAfterMs: undefined });
    expect(new AgentSessionInUseError('In use.', { retryAfterMs: 1.5 }).retryAfterMs).toBeUndefined();
  });

  it('say when a usage limit resets, and only for a time a date can hold', () => {
    const limited = new AgentRuntimeError('native_usage_limited', 'Usage limit reached.', { resetsAt: 1_763_700_000_000 });
    expect(limited).toMatchObject({ name: 'AgentRuntimeError', code: 'native_usage_limited', resetsAt: 1_763_700_000_000 });
    expect(new AgentRuntimeError('native_usage_limited', 'Usage limit reached.', { resetsAt: Number.NaN }).resetsAt).toBeUndefined();
    expect(new AgentRuntimeError('native_exited', 'The CLI exited.').resetsAt).toBeUndefined();
  });

  it.each(['native_usage_limited', 'native_auth_missing', 'native_exited', 'native_unresponsive'] as const)('name %s', code => {
    expect(new AgentRuntimeError(code, 'A failure.').code).toBe(code);
  });
});
