import { expect, it } from 'vitest';
import { sessionHeartbeatInterval, sessionHeartbeatTools } from './session-heartbeat.js';

it('composes heartbeat scheduling without a todo list or TPM role and bounds model requests', async () => {
  const scheduled: Array<{ at: number; reason: string }> = [];
  const [tool] = sessionHeartbeatTools({ read: async () => ({ now: 100000, lastReviewAt: 99000, intervalMs: 300000, minimumIntervalMs: 30000 }),
    schedule: async (at, reason) => { scheduled.push({ at, reason }); return { nextCheckAt: at }; } });
  await tool!.execute({ seconds: 86400, reason: 'Wait for evidence' });
  expect(scheduled).toEqual([{ at: 400000, reason: 'Wait for evidence' }]);
  await tool!.execute({ seconds: 30, reason: 'Check main progress' });
  expect(scheduled[1]?.at).toBe(130000);
  await expect(tool!.execute({ seconds: 0, reason: 'Busy loop' })).rejects.toThrow();
  expect(sessionHeartbeatInterval(false)).toBe(300000);
  expect(sessionHeartbeatInterval(true)).toBe(1800000);
});
