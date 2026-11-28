import { describe, expect, it } from 'vitest';
import type { ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';
import { readForkContext, type ForkSourceAgent } from './fork-context.js';

// The conversation a sub-session is forked from is read through its session's timeline pages; the session is a stub.
const user = (seq: number, text: string) => ({ seq, item: { type: 'user_message', text } }) as ProjectedTimelineEntry;
const reply = (seq: number, text: string) => ({ seq, item: { type: 'assistant_message', text } }) as ProjectedTimelineEntry;
const turns = (count: number) => Array.from({ length: count }, (_, turn) => [user(turn * 2 + 1, `question ${turn}`), reply(turn * 2 + 2, `answer ${turn}`)]).flat();

/** A session whose timeline holds `all`, served `size` entries at a time from the newest. */
function session(all: ProjectedTimelineEntry[], options: { history?: boolean; size?: number } = {}): ForkSourceAgent & { requests: Array<{ direction: string; cursor?: unknown }> } {
  const requests: Array<{ direction: string; cursor?: unknown }> = [];
  return { requests, agentId: 'agent', capabilities: { history: options.history ?? true },
    async fetchTimeline(request) {
      requests.push({ direction: request.direction, ...(request.cursor ? { cursor: request.cursor } : {}) });
      const end = request.cursor ? all.findIndex(entry => entry.seq === request.cursor!.seq) : all.length;
      const start = Math.max(0, end - (options.size ?? 100));
      return { payload: { entries: all.slice(start, end), hasOlder: start > 0, startCursor: start > 0 ? { epoch: 'e', seq: all[start]!.seq } : null, reset: false, staleCursor: false, gap: false, error: null } };
    } };
}
const now = () => '2026-11-28T00:00:00.000Z';

describe('the conversation a sub-session is forked from', () => {
  it('is its last turns, read back through as many pages as they take', async () => {
    const agent = session(turns(10), { size: 4 });
    const carry = await readForkContext(agent, { providerId: 'claude', nativeSessionId: 'main' }, 3, now);
    expect(carry).toMatchObject({ turns: 3, shortened: false });
    expect(carry.context).toContain('question 7'); expect(carry.context).toContain('answer 9'); expect(carry.context).not.toContain('question 6');
    expect(carry.context).toContain('"sourceSession":"main"');
    expect(agent.requests.map(request => request.direction)).toEqual(['tail', 'before']);
  });
  it('is refused, saying why, for a provider that cannot read its history, and for a conversation without turns', async () => {
    await expect(readForkContext(session(turns(2), { history: false }), { providerId: 'dsh', nativeSessionId: 'main' }, 2, now)).rejects.toThrow('dsh cannot carry its conversation into a sub-session');
    await expect(readForkContext(session([]), { providerId: 'claude', nativeSessionId: 'main' }, 2, now)).rejects.toThrow('no turns to carry');
  });
  it('is refused when the timeline changed under the read', async () => {
    const agent = session(turns(2)); const read = agent.fetchTimeline;
    agent.fetchTimeline = async request => { const page = await read(request); return { payload: { ...page.payload, reset: true } }; };
    await expect(readForkContext(agent, { providerId: 'claude', nativeSessionId: 'main' }, 2, now)).rejects.toThrow('changed while it was read');
  });
});
