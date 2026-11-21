import { describe, expect, it } from 'vitest';
import { landedMidTurn } from './restart-round.js';

const story = 'The lighthouse keeper climbed the stairs. '.repeat(4);
const row = (key: string, kind: string, text: string) => ({ key, kind, text });

describe('the fault of a restart round lands mid-turn', () => {
  // The rounds of a run share their session: earlier turns left long replies and tool calls behind.
  const before = new Set(['old-story', 'old-tool']);
  const earlier = [row('old-story', 'assistant_message', story), row('old-tool', 'tool_call', 'sleep 20')];
  it("waits for this turn's own rows, not the long reply or the tool call of an earlier round", () => {
    expect(landedMidTurn(earlier, before, 'streaming')).toBe(false);
    expect(landedMidTurn(earlier, before, 'tool-call')).toBe(false);
  });
  it('lands once this turn streams a long enough reply or shows a tool call', () => {
    expect(landedMidTurn([...earlier, row('new-reply', 'assistant_message', 'Once')], before, 'streaming')).toBe(false);
    expect(landedMidTurn([...earlier, row('new-reply', 'assistant_message', story)], before, 'streaming')).toBe(true);
    expect(landedMidTurn([...earlier, row('new-tool', 'tool_call', 'sleep 20')], before, 'tool-call')).toBe(true);
  });
});
