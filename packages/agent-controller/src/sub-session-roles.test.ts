import { describe, expect, it } from 'vitest';
import type { TeamSeat } from '@orchardworks/agent-remote-protocol';
import { subSessionInstructions } from './sub-session-roles.js';

const seat = (member: Record<string, unknown> = {}) => ({ teamId: 't', source: { hostId: 'h', providerId: 'codex', nativeSessionId: 'chief', title: 'Chief' },
  member: { id: 'w', role: 'leader', hostId: 'h', providerId: 'codex', name: 'Sub-session', responsibility: 'Reviewer', creation: 'reserved', activity: 'unknown', summary: '', updatedAt: 1, ...member },
  task: { title: 'Reviewer' } }) as unknown as TeamSeat;

describe('what a sub-session is told', () => {
  it('names its bot and itself, says it is no bot, and has it report each piece of work with communicate_update', () => {
    const text = subSessionInstructions(seat());
    expect(text).toContain('a sub-session of the bot "Chief", named "Reviewer"');
    expect(text).toContain('not a bot');
    expect(text).toContain('communicate_update with a final_summary');
    expect(text).toContain('current_step');
    expect(text).toContain('more related work may follow later, so keep what you learn in mind');
    expect(text).toContain('You cannot message or create bots');
    expect(text).toContain('read_main_session');
    expect(text).not.toContain('message your chief');
    expect(text).not.toContain('temporary');
  });
  it('says where it works: beside its bot, read-only, or in a worktree of its own', () => {
    expect(subSessionInstructions(seat())).toContain('your bot may change it too');
    expect(subSessionInstructions(seat({ access: 'read_only' }))).toContain('without changing it');
    expect(subSessionInstructions(seat({ workspace: { kind: 'worktree', commit: 'abc1234' } }))).toContain('worktree of your bot\'s repository, at commit abc1234');
  });
});
