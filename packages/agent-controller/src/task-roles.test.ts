import { expect, it } from 'vitest';
import type { TeamSeat } from '@orchardworks/agent-remote-protocol';
import { taskWorkerInstructions } from './task-roles.js';

const seat = (task: { title: string; side?: true }) => ({ teamId: 't', source: { hostId: 'h', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' },
  member: { id: 'w', role: 'leader', hostId: 'h', providerId: 'codex', name: 'Worker', responsibility: task.title, creation: 'reserved', activity: 'unknown', summary: '', updatedAt: 1 }, task }) as unknown as TeamSeat;

it('tells a side to answer in its reply and message no one, and any other temporary bot to message its chief', () => {
  const side = taskWorkerInstructions(seat({ title: 'Notes', side: true }));
  expect(side).toContain('Answer in your reply');
  expect(side).toContain('Do not message anyone, and write no file you were not asked for');
  expect(side).not.toContain('message your chief once');
  expect(taskWorkerInstructions(seat({ title: 'Reviewer' }))).toContain('message your chief once');
});
