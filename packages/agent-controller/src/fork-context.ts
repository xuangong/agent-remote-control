/**
 * The conversation a sub-session starts with. A sub-session forked from its bot's main conversation is given the last turns of it,
 * read from the main session's timeline here and quoted as the page quotes a `/fork` (`recentTurnsContext`).
 *
 * Contract
 * - A provider whose session cannot read its history (`capabilities.history`) cannot be forked: the read refuses, naming the provider.
 *   A sub-session never starts fresh when a fork was asked for.
 * - Pages are read back from the newest until enough user messages are in hand or the history ends. A page that reset, went stale, has a
 *   gap or an error means the conversation moved during the read: the read refuses and the bot asks again.
 * - A conversation without turns has nothing to carry and refuses.
 */
import { randomUUID } from 'node:crypto';
import { recentTurnsContext, type NativeSessionRef, type ProjectedTimelineEntry } from '@orchardworks/agent-remote-protocol';

const PAGE_ENTRIES = 100;
const PAGE_LIMIT = 10;

interface ForkTimelinePage { payload: { entries: ProjectedTimelineEntry[]; hasOlder: boolean; startCursor: { epoch: string; seq: number } | null; reset: boolean; staleCursor: boolean; gap: boolean; error: string | null } }
/** What the read needs of a session. */
export interface ForkSourceAgent {
  readonly agentId: string;
  readonly capabilities: { readonly history: boolean };
  fetchTimeline(request: { requestId: string; agentId: string; direction: 'tail' | 'before'; limit: number; cursor?: { epoch: string; seq: number } }): ForkTimelinePage | Promise<ForkTimelinePage>;
}

export async function readForkContext(agent: ForkSourceAgent, source: NativeSessionRef, turns: number, now: () => string): Promise<{ turns: number; context: string; shortened: boolean }> {
  if (!agent.capabilities.history) throw new Error(`${source.providerId} cannot carry its conversation into a sub-session; start it without fork_from.`);
  let entries: ProjectedTimelineEntry[] = [], cursor: { epoch: string; seq: number } | undefined;
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const { payload } = await agent.fetchTimeline({ requestId: randomUUID(), agentId: agent.agentId, direction: cursor ? 'before' : 'tail', limit: PAGE_ENTRIES, ...(cursor ? { cursor } : {}) });
    if (payload.reset || payload.staleCursor || payload.gap || payload.error) throw new Error('The conversation changed while it was read; try again.');
    entries = [...payload.entries, ...entries];
    if (entries.filter(entry => entry.item.type === 'user_message').length >= turns || !payload.hasOlder || !payload.startCursor) break;
    cursor = payload.startCursor;
  }
  const carry = recentTurnsContext(entries, turns, { sourceSession: source.nativeSessionId, capturedAt: now() });
  return carry ?? (() => { throw new Error('Your conversation has no turns to carry yet.'); })();
}
