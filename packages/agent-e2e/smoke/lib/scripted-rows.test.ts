import { describe, expect, it } from 'vitest';
import { heavyHistory, toolCall } from './scripted-rows.js';

const itemOf = (observation: ReturnType<typeof toolCall>) => (observation.event as { item: Record<string, any> }).item;

describe('scripted rows for quota pressure', () => {
  it('writes a finished tool call with exactly the requested output, and a running one with none', () => {
    const done = itemOf(toolCall('scripted', 'k', { command: 'c', chars: 1000 }));
    expect(done).toMatchObject({ status: 'completed', result: { exitCode: 0 } });
    expect(done.result.content[0].text).toHaveLength(1000);
    const running = itemOf(toolCall('scripted', 'k', { command: 'c', running: true }));
    expect(running).toMatchObject({ status: 'running' });
    expect(running.result).toBeUndefined();
    expect(toolCall('scripted', 'k', { command: 'c', running: true }).itemIdentity).toEqual({ key: 'k' });
    expect(toolCall('scripted', 'k', { command: 'c' }).itemIdentity).toEqual({ key: 'k', completes: true });
  });
  it('builds a history of a question, the calls and an answer, with keys that do not collide', () => {
    const history = heavyHistory('scripted', 's', { calls: 3, chars: 100, answer: 'END' });
    expect(history).toHaveLength(5);
    expect(history[0]).toMatchObject({ role: 'user' });
    expect(history.at(-1)).toMatchObject({ role: 'assistant', text: 'END' });
    const keys = history.flatMap(entry => 'observation' in entry ? [entry.observation.itemIdentity!.key] : []);
    expect(new Set(keys).size).toBe(3);
  });
});
