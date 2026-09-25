import { expect, it, vi } from 'vitest';
import { CodexSessionTakeover } from './session-takeover.js';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture() {
  let writer: {pid: number; identity: string} | undefined = {pid: 123, identity: 'process-start-and-lock-inode'};
  const ops = {inspect: vi.fn(async () => writer), signal: vi.fn(() => {writer = undefined;})};
  return {ops, takeover: new CodexSessionTakeover('/isolated', ops, undefined, 100), replace: () => {writer = {pid: 123, identity: 'different-process-or-lock'};}};
}
it('requires matching process incarnation before signaling the exact writer', async () => {
  const f = fixture(), owner = await f.takeover.inspect(id);
  expect(owner?.generation).toMatch(/^[a-f\d-]{36}$/);
  await f.takeover.release(id, owner!.generation);
  expect(f.ops.signal).toHaveBeenCalledExactlyOnceWith(123);
});
it('does not stop a replacement process even if the PID is reused', async () => {
  const f = fixture(), owner = await f.takeover.inspect(id); f.replace();
  await expect(f.takeover.release(id, owner!.generation)).rejects.toMatchObject({code: 'native_owner_changed'});
  expect(f.ops.signal).not.toHaveBeenCalled();
});
it('does not offer takeover for an unknown owner or invalid session path', async () => {
  const f = fixture();
  expect(await f.takeover.inspect('../elsewhere')).toBeUndefined(); expect(f.ops.inspect).not.toHaveBeenCalled();
  f.ops.inspect.mockRejectedValue(new Error('permission denied'));
  expect(await f.takeover.inspect(id)).toBeUndefined();
});
it('does not escalate to killing other processes or force retry after timeout', async () => {
  const f = fixture(); f.ops.signal.mockImplementation(() => {});
  const owner = await f.takeover.inspect(id);
  await expect(f.takeover.release(id, owner!.generation)).rejects.toMatchObject({code: 'native_handoff_unknown'});
  expect(f.ops.signal).toHaveBeenCalledExactlyOnceWith(123);
});
