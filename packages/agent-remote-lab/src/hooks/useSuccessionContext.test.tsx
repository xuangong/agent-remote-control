import { act, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { useSuccessionContext } from './useSuccessionContext.js';

const target = { controllerId: 'controller', providerId: 'test', nativeSessionId: 'B' };
const source = { ...target, nativeSessionId: 'A' };
const record = { operationId: 'handoff', roleId: 'role', expectedRevision: 1, from: source, to: target, phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now' };
const result = { record, role: { id: 'role', revision: 2, origin: source, current: target, workspace: { controllerId: 'controller', canonicalCwd: '/work' } } };
afterEach(() => { vi.useRealTimers(); });

it('reads status explicitly, retains accepted delivery and stops polling on authoritative materialization', async () => {
  vi.useFakeTimers();
  let state = 'pending';
  const bodies: unknown[] = [];
  const directory = new SessionDirectoryClient('https://relay.example/', (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ...result, context: { operationId: 'handoff', target, state } });
  }) as typeof fetch, 'host');
  let context: ReturnType<typeof useSuccessionContext>;
  function View() { context = useSuccessionContext({ directory, operationId: 'handoff', target }); return <span>{context?.state}</span>; }
  const container = await render(<View />);
  expect(container.textContent).toBe('pending');
  expect(bodies).toEqual([{ operationId: 'handoff', includeContext: true }]);
  state = 'accepted';
  await act(async () => context!.onRetry());
  expect(container.textContent).toBe('accepted');
  state = 'materialized';
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.textContent).toBe('materialized');
  const reads = bodies.length;
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(bodies).toHaveLength(reads);
}, 10000);

it.each(['missing', 'wrong-target', 'failed'] as const)('keeps restrictions explicit for %s context confirmation', async kind => {
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => {
    if (kind === 'failed') throw new Error('Host disconnected');
    return Response.json({ ...result, ...(kind === 'missing' ? {} : { context: { operationId: 'handoff', target: source, state: 'materialized' } }) });
  }) as typeof fetch, 'host');
  function View() { const context = useSuccessionContext({ directory, operationId: 'handoff', target }); return <span>{context?.state}</span>; }
  expect((await render(<View />)).textContent).toBe('unavailable');
}, 10000);

it('limits unresolved polling and leaves an explicit retry instead of assuming the context was delivered', async () => {
  vi.useFakeTimers();
  let reads = 0;
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => {
    reads++;
    return Response.json({ ...result, context: { operationId: 'handoff', target, state: 'unknown' } });
  }) as typeof fetch, 'host');
  let context: ReturnType<typeof useSuccessionContext>;
  function View() { context = useSuccessionContext({ directory, operationId: 'handoff', target }); return <span>{context?.state}</span>; }
  const container = await render(<View />);
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(reads).toBe(6);
  expect(container.textContent).toBe('unknown');
  await act(async () => vi.advanceTimersByTimeAsync(120000));
  expect(reads).toBe(6);
  await act(async () => context!.onRetry());
  expect(reads).toBe(7);
}, 10000);

it('keeps a new target restricted when a previous target responds late', async () => {
  let complete!: (response: Response) => void;
  const held = new Promise<Response>(resolve => { complete = resolve; });
  const next = { ...target, nativeSessionId: 'C' };
  const directory = new SessionDirectoryClient('https://relay.example/', (async (_url, init) => JSON.parse(String(init?.body)).operationId === 'handoff' ? held : Response.json({
    record: { ...record, operationId: 'next', from: target, to: next, expectedRevision: 2, committedRevision: 3 },
    role: { ...result.role, current: next, revision: 3 }, context: { operationId: 'next', target: next, state: 'pending' },
  })) as typeof fetch, 'host');
  let select!: () => void;
  function View() {
    const [changed, change] = useState(false); select = () => change(true);
    const context = useSuccessionContext({ directory, operationId: changed ? 'next' : 'handoff', target: changed ? next : target });
    return <span>{context?.state}</span>;
  }
  const container = await render(<View />);
  expect(container.textContent).toBe('restoring');
  await act(async () => select());
  expect(container.textContent).toBe('pending');
  await act(async () => complete(Response.json({ ...result, context: { operationId: 'handoff', target, state: 'materialized' } })));
  expect(container.textContent).toBe('pending');
}, 10000);

it('rechecks an observation that arrives during an earlier pending-context read', async () => {
  vi.useFakeTimers();
  let complete!: (response: Response) => void, reads = 0, update!: () => void;
  const held = new Promise<Response>(resolve => { complete = resolve; });
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => ++reads === 1 ? held
    : Response.json({ ...result, context: { operationId: 'handoff', target, state: 'accepted' } })) as typeof fetch, 'host');
  function View() {
    const [revision, change] = useState(0); update = () => change(value => value + 1);
    const context = useSuccessionContext({ directory, operationId: 'handoff', target, refreshKey: revision });
    return <span>{context?.state}</span>;
  }
  const container = await render(<View />);
  await act(async () => update());
  await act(async () => complete(Response.json({ ...result, context: { operationId: 'handoff', target, state: 'pending' } })));
  expect(container.textContent).toBe('pending');
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(reads).toBe(2);
  expect(container.textContent).toBe('accepted');
}, 10000);

it.each(['pending', 'materialized'] as const)('retains %s evidence while offline and does not query until access returns', async state => {
  vi.useFakeTimers();
  let reads = 0, enable!: (value: boolean) => void;
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => {
    reads++;
    return Response.json({ ...result, context: { operationId: 'handoff', target, state } });
  }) as typeof fetch, 'host');
  let context: ReturnType<typeof useSuccessionContext>;
  function View() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    context = useSuccessionContext({ directory, operationId: 'handoff', target, enabled });
    return <span>{context?.state}</span>;
  }
  const container = await render(<View />);
  expect(container.textContent).toBe(state);
  await act(async () => enable(false));
  expect(container.textContent).toBe(state);
  await act(async () => { context!.onRetry(); window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(120000); });
  expect(reads).toBe(1);
  await act(async () => enable(true));
  expect(container.textContent).toBe(state);
  expect(reads).toBe(state === 'materialized' ? 1 : 2);
}, 10000);

it('keeps a successor restricted when it first mounts without Host access', async () => {
  let reads = 0;
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => { reads++; throw new Error('Offline'); }) as typeof fetch, 'host');
  function View() { const context = useSuccessionContext({ directory, operationId: 'handoff', target, enabled: false }); return <span>{context?.state}</span>; }
  expect((await render(<View />)).textContent).toBe('restoring');
  expect(reads).toBe(0);
}, 10000);

it('ignores an aborted pre-disconnection response after a new online read has started', async () => {
  let finishOld!: (value: Response) => void, finishCurrent!: (value: Response) => void, enable!: (value: boolean) => void, reads = 0;
  const old = new Promise<Response>(resolve => { finishOld = resolve; });
  const current = new Promise<Response>(resolve => { finishCurrent = resolve; });
  const directory = new SessionDirectoryClient('https://relay.example/', (async () => ++reads === 1 ? old : current) as typeof fetch, 'host');
  function View() {
    const [enabled, setEnabled] = useState(true); enable = setEnabled;
    const context = useSuccessionContext({ directory, operationId: 'handoff', target, enabled });
    return <span>{context?.state}</span>;
  }
  const container = await render(<View />);
  await act(async () => enable(false));
  await act(async () => enable(true));
  expect(reads).toBe(2);
  await act(async () => finishOld(Response.json({ ...result, context: { operationId: 'handoff', target, state: 'materialized' } })));
  expect(container.textContent).toBe('restoring');
  await act(async () => finishCurrent(Response.json({ ...result, context: { operationId: 'handoff', target, state: 'pending' } })));
  expect(container.textContent).toBe('pending');
}, 10000);
