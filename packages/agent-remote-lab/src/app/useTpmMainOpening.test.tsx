import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useTpmMainOpening } from './useTpmMainOpening.js';

const hostedMain = (overrides: Record<string, unknown> = {}) => ({ hostId: 'local', work: { providerId: 'codex', mainNativeSessionId: 'main', ...overrides } });
const entry = { hostId: 'local', providerId: 'codex', nativeSessionId: 'main', title: 'Main title' };

function scopeOf(facts: Record<string, unknown> = {}) {
  const request = { current: 0 };
  const scope = {
    accessReadyRef: { current: true }, baseUrl: 'https://relay', mountedTransport: { current: 'transport' }, sessionEntries: [entry], setFailure: vi.fn(), tpm: { refresh: vi.fn(async () => undefined) },
    tpmMainRequest: request, tpmMainState: { current: { scope: 'https://relay', transport: 'transport', hosts: [], providers: [{ providerId: 'codex' }] } }, transport: 'transport',
    openSession: vi.fn(async () => true), ...facts,
  };
  return { scope, mock: mockScope<typeof useTpmMainOpening>(scope) };
}

async function open(item: unknown, facts: Record<string, unknown> = {}) {
  const built = scopeOf(facts);
  const { result } = await renderHook(() => useTpmMainOpening(built.mock));
  await result.current.openTpmMain(item as never);
  return built.scope;
}

afterEach(() => vi.restoreAllMocks());

describe('opening the main session of a work item', () => {
  it('opens the session of its main reference under the title the list knows', async () => {
    const scope = await open(hostedMain());
    expect(scope.openSession).toHaveBeenCalledWith({ hostId: 'local', providerId: 'codex', nativeSessionId: 'main', title: 'Main title' });
    expect(scope.setFailure).not.toHaveBeenCalled();
  });
  it('titles an unlisted main session generically', async () => {
    const scope = await open(hostedMain(), { sessionEntries: [] });
    expect(scope.openSession).toHaveBeenCalledWith(expect.objectContaining({ title: 'Main session' }));
  });
  it('stays silent while workspace access is restoring: the request is no longer current', async () => {
    const scope = await open(hostedMain(), { accessReadyRef: { current: false } });
    expect(scope.openSession).not.toHaveBeenCalled();
    expect(scope.setFailure).not.toHaveBeenCalled();
  });
  it('refuses a provider the Host does not offer', async () => {
    const scope = await open(hostedMain({ providerId: 'claude', mainNativeSessionId: 'main' }));
    expect(scope.setFailure).toHaveBeenCalledWith('The main session provider is unavailable on this Host.');
  });
  it('refuses a remote Host that is offline or unknown', async () => {
    const remote = { hostId: 'remote', work: { providerId: 'codex', mainNativeSessionId: 'main' } };
    for (const hosts of [[], [{ id: 'remote', online: false, providers: [{ providerId: 'codex' }] }]]) {
      const scope = await open(remote, { tpmMainState: { current: { scope: 'https://relay', transport: 'transport', hosts, providers: [] } } });
      expect(scope.setFailure).toHaveBeenCalledWith('The main session provider is unavailable on this Host.');
    }
  });
  it('opens on a remote Host that is online and offers the provider', async () => {
    const remote = { hostId: 'remote', work: { providerId: 'codex', mainNativeSessionId: 'main' } };
    const scope = await open(remote, { tpmMainState: { current: { scope: 'https://relay', transport: 'transport', hosts: [{ id: 'remote', online: true, providers: [{ providerId: 'codex' }] }], providers: [] } } });
    expect(scope.openSession).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'remote' }));
  });
});

describe('a main session that follows a role', () => {
  const role = (overrides: Record<string, unknown> = {}) => hostedMain({ mainBinding: { kind: 'primary_role', roleId: 'role-1' },
    mainSessionRef: { controllerId: 'c1', providerId: 'codex', nativeSessionId: 'main' }, ...overrides });
  const current = (overrides: Record<string, unknown> = {}) => ({ locator: { hostId: 'local' }, role: { current: { controllerId: 'c1', providerId: 'codex', nativeSessionId: 'main', ...overrides } } });
  const transportWith = (answer: unknown) => ({ fetchSessionSuccessionCurrent: vi.fn(async () => answer) });
  it('opens it once the Relay confirms the reference is still current', async () => {
    const transport = transportWith(current());
    const scope = await open(role(), { transport, mountedTransport: { current: transport }, tpmMainState: { current: { scope: 'https://relay', transport, hosts: [], providers: [{ providerId: 'codex' }] } } });
    expect(transport.fetchSessionSuccessionCurrent).toHaveBeenCalledWith('role-1', expect.objectContaining({ signal: expect.anything() }));
    expect(scope.openSession).toHaveBeenCalled();
  });
  it('refreshes the list and asks to open it again when the role moved on', async () => {
    const transport = transportWith(current({ nativeSessionId: 'successor' }));
    const scope = await open(role(), { transport, mountedTransport: { current: transport }, tpmMainState: { current: { scope: 'https://relay', transport, hosts: [], providers: [{ providerId: 'codex' }] } } });
    expect(scope.tpm.refresh).toHaveBeenCalled();
    expect(scope.openSession).not.toHaveBeenCalled();
    expect(scope.setFailure).toHaveBeenCalledWith('The main session changed. TPM has been refreshed; open its current main session again.');
  });
  it('refuses without a mapping or a transport that can look the role up', async () => {
    const scope = await open(role({ mainSessionRef: undefined }));
    expect(scope.setFailure).toHaveBeenCalledWith('The current main session mapping is unavailable. Refresh TPM and retry.');
  });
  it('drops the answer when a newer request started meanwhile', async () => {
    const built = scopeOf();
    const slow = { fetchSessionSuccessionCurrent: vi.fn(async () => { built.scope.tpmMainRequest.current += 1; return current(); }) };
    Object.assign(built.scope, { transport: slow, mountedTransport: { current: slow }, tpmMainState: { current: { scope: 'https://relay', transport: slow, hosts: [], providers: [{ providerId: 'codex' }] } } });
    const { result } = await renderHook(() => useTpmMainOpening(built.mock));
    await result.current.openTpmMain(role() as never);
    expect(built.scope.openSession).not.toHaveBeenCalled();
    expect(built.scope.setFailure).not.toHaveBeenCalled();
  });
});
