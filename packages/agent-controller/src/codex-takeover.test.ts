import { expect, it, vi } from 'vitest';
import { AgentSessionInUseError } from '@orchardworks/agent-provider-sdk';
import { createCodexSessionDirectory } from './directory.js';
const generation = '11111111-1111-4111-8111-111111111111';
function fixture() {
  let occupied = true;
  const session: any = {runtimeInfo: async () => ({sessionId: 'native', status: 'idle', sessionControl: 'shared', persistence: {providerId: 'codex', sessionId: 'native', opaque: '{}'}}), dispose: vi.fn()};
  const provider = {
    listSessions: async () => ({sessions: []}), createSession: vi.fn(), openChildSession: vi.fn(),
    resumeSession: vi.fn(async () => {if (occupied) throw new AgentSessionInUseError('busy'); return session;}),
    inspectSessionOwner: vi.fn(async () => ({generation})),
    releaseSessionOwner: vi.fn(async () => {occupied = false;}),
  };
  return {provider, session, directory: createCodexSessionDirectory(provider, []), release: () => {occupied = false;}};
}
it('offers explicit takeover without stopping the private writer on open', async () => {
  const f = fixture();
  await expect(f.directory.open('native')).rejects.toMatchObject({code: 'native_session_owned', owner: {kind: 'native_cli', generation}});
  expect(f.provider.releaseSessionOwner).not.toHaveBeenCalled();
});
it('releases the confirmed writer and resumes the same ID as shared', async () => {
  const f = fixture();
  expect(await f.directory.open('native', {takeOver: generation})).toBe(f.session);
  expect(f.provider.releaseSessionOwner).toHaveBeenCalledWith('native', generation);
  expect(f.provider.resumeSession).toHaveBeenLastCalledWith({providerId: 'codex', sessionId: 'native', opaque: '{}'}, undefined);
  expect(await f.directory.open('native')).toBe(f.session);
  expect(f.provider.releaseSessionOwner).toHaveBeenCalledTimes(1);
});
it('rejects stale confirmation without stopping the new owner', async () => {
  const f = fixture();
  await expect(f.directory.open('native', {takeOver: '22222222-2222-4222-8222-222222222222'})).rejects.toMatchObject({code: 'native_owner_changed'});
  expect(f.provider.releaseSessionOwner).not.toHaveBeenCalled();
});
it('opens an already released or shared session without terminating anything', async () => {
  const f = fixture(); f.release();
  expect(await f.directory.open('native', {takeOver: generation})).toBe(f.session);
  expect(f.provider.inspectSessionOwner).not.toHaveBeenCalled(); expect(f.provider.releaseSessionOwner).not.toHaveBeenCalled();
});
it('retains the ordinary in-use error when the owner cannot be safely identified', async () => {
  const f = fixture(); f.provider.inspectSessionOwner.mockResolvedValue(undefined as any);
  await expect(f.directory.open('native')).rejects.toBeInstanceOf(AgentSessionInUseError);
  expect(f.provider.releaseSessionOwner).not.toHaveBeenCalled();
});
