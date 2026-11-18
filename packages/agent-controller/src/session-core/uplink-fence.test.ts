import { describe, expect, it } from 'vitest';

import { createUplinkFence } from './uplink-fence.js';

const flush = () => new Promise<void>(resolve => { setTimeout(resolve, 0); });

describe('uplink fence', () => {
  it('lets the latest connection act and supersedes the one before it', () => {
    const fence = createUplinkFence();
    const first = fence.begin();
    expect(fence.isCurrent(first)).toBe(true);
    const second = fence.begin();
    expect(fence.isCurrent(first)).toBe(false);
    expect(fence.isCurrent(second)).toBe(true);
  });

  it('runs an action only for a current connection', () => {
    const fence = createUplinkFence();
    const ran: string[] = [];
    const first = fence.begin();
    const second = fence.begin();
    expect(fence.whenCurrent(first, () => ran.push('first'))).toBe(false);
    expect(fence.whenCurrent(second, () => ran.push('second'))).toBe(true);
    expect(ran).toEqual(['second']);
  });

  it('ends every connection when it closes, and a connection begun after it is not current', () => {
    const fence = createUplinkFence();
    const token = fence.begin();
    fence.close();
    expect(fence.closed).toBe(true);
    expect(fence.isCurrent(token)).toBe(false);
    expect(fence.isCurrent(fence.begin())).toBe(false);
  });

  it('writes credentials one at a time, in the order they arrive', async () => {
    const fence = createUplinkFence();
    const token = fence.begin();
    const log: string[] = [];
    let release!: () => void;
    const first = fence.persistCredential(token, async credential => { log.push(`start ${credential}`); await new Promise<void>(resolve => { release = resolve; }); log.push(`end ${credential}`); }, 'one');
    const second = fence.persistCredential(token, async credential => { log.push(`start ${credential}`); }, 'two');
    await flush();
    expect(log).toEqual(['start one']);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(['start one', 'end one', 'start two']);
  });

  it('refuses a queued write whose connection was superseded before its turn, so an old save cannot overwrite a new key', async () => {
    const fence = createUplinkFence();
    const old = fence.begin();
    let release!: () => void;
    const saved: string[] = [];
    const first = fence.persistCredential(old, async credential => { await new Promise<void>(resolve => { release = resolve; }); saved.push(credential); }, 'old-1');
    const queued = fence.persistCredential(old, async credential => { saved.push(credential); }, 'old-2');
    await flush();
    const replacement = fence.begin();
    const fresh = fence.persistCredential(replacement, async credential => { saved.push(credential); }, 'new');
    release();
    await first;
    await expect(queued).rejects.toThrow('Host credential persistence was superseded.');
    await fresh;
    expect(saved).toEqual(['old-1', 'new']);
  });

  it('keeps writing after a write failed', async () => {
    const fence = createUplinkFence();
    const token = fence.begin();
    const failed = fence.persistCredential(token, async () => { throw new Error('disk full'); }, 'one');
    const saved: string[] = [];
    const next = fence.persistCredential(token, async credential => { saved.push(credential); }, 'two');
    await expect(failed).rejects.toThrow('disk full');
    await next;
    expect(saved).toEqual(['two']);
  });
});
