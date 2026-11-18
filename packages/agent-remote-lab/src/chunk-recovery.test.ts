import { describe, expect, it, vi } from 'vitest';

import { loadChunkWithRecovery } from './chunk-recovery.js';

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
};

const options = () => ({ retryDelaysMs: [10, 20], wait: vi.fn(async () => undefined), reload: vi.fn(), storage: memoryStorage() });

describe('loadChunkWithRecovery', () => {
  it('returns the chunk of a load that works', async () => {
    const o = options();
    await expect(loadChunkWithRecovery(async () => 'app', o)).resolves.toBe('app');
    expect(o.wait).not.toHaveBeenCalled();
    expect(o.reload).not.toHaveBeenCalled();
  });

  it('retries a failed fetch with backoff and returns the chunk without a reload', async () => {
    const o = options();
    const load = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('502')).mockRejectedValueOnce(new Error('502')).mockResolvedValue('app');
    await expect(loadChunkWithRecovery(load, o)).resolves.toBe('app');
    expect(load).toHaveBeenCalledTimes(3);
    expect(o.wait.mock.calls).toEqual([[10], [20]]);
    expect(o.reload).not.toHaveBeenCalled();
  });

  it('reloads the page once when every retry failed, and stays pending while it reloads', async () => {
    const o = options();
    const load = vi.fn(async () => { throw new Error('offline'); });
    const settled = vi.fn();
    void loadChunkWithRecovery(load, o).then(settled, settled);
    await vi.waitFor(() => expect(o.reload).toHaveBeenCalledTimes(1));
    expect(load).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it('does not reload again after a reload that failed too: it rejects with the failure', async () => {
    const o = options();
    const load = async () => { throw new Error('offline'); };
    void loadChunkWithRecovery(load, o);
    await vi.waitFor(() => expect(o.reload).toHaveBeenCalledTimes(1));
    await expect(loadChunkWithRecovery(load, o)).rejects.toThrow('offline');
    expect(o.reload).toHaveBeenCalledTimes(1);
  });

  it('lets a later failure recover again after a load succeeded', async () => {
    const o = options();
    const failing = async () => { throw new Error('offline'); };
    void loadChunkWithRecovery(failing, o);
    await vi.waitFor(() => expect(o.reload).toHaveBeenCalledTimes(1));
    await loadChunkWithRecovery(async () => 'app', o);
    void loadChunkWithRecovery(failing, o);
    await vi.waitFor(() => expect(o.reload).toHaveBeenCalledTimes(2));
  });
});
