import { expect, test } from 'vitest';
import type { SessionWireAgent } from '@orchardworks/agent-remote-relay';
import { captureSuccessionTimeline } from './session-succession-capture.js';
function fixture() {
  let current = { epoch: 'epoch', seq: 2 };
  const requests: unknown[] = [];
  const agent = { agentId: 'agent', timelineCursor: () => current,
    async loadTimeline(request: { cursor?: { seq: number } }) {
      requests.push(request);
      const seq = request.cursor ? -1 : 2;
      return { payload: { epoch: 'epoch', reset: false, staleCursor: false, gap: false, error: null,
        entries: [{seqStart:seq, seqEnd:seq, item:{type:'user_message',text:seq===2?'latest':'older'}}], hasOlder: !request.cursor,
        startCursor: {epoch:'epoch',seq} } };
    },
  } as unknown as SessionWireAgent;
  return { agent, requests, change: () => { current = {epoch:'epoch',seq:3}; } };
}
test('captures older normalized history in chronological order at one boundary', async () => {
  const f = fixture();
  expect(await captureSuccessionTimeline(f.agent)).toMatchObject({ boundary: {epoch:'epoch',seq:2}, entries:[{seqStart:-1},{seqStart:2}] });
  expect(f.requests).toHaveLength(2);
});
test('rejects a changed boundary and incomplete pages rather than silently dropping history', async () => {
  const f = fixture(), load = f.agent.loadTimeline!;
  f.agent.loadTimeline = async request => { const page = await load(request); f.change(); return page; };
  await expect(captureSuccessionTimeline(f.agent)).rejects.toThrow(/changed/);
  const g = fixture(), original = g.agent.loadTimeline!;
  g.agent.loadTimeline = async request => { const page=await original(request); page.payload.gap=true; return page; };
  await expect(captureSuccessionTimeline(g.agent)).rejects.toThrow(/incomplete/);
});
