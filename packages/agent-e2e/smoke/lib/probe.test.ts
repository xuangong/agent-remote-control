import { describe, expect, it } from 'vitest';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import { deviceKey } from '@orchardworks/agent-client/device-store';
import { keptRecordOf, linkedSession, sessionPane } from './probe.js';

const origin = 'http://127.0.0.1:61630';

describe('the conversation a smoke page reads and drives', () => {
  it('is the session its link opens, named as the command line names it', () => {
    // The Controller's `session link` and a scripted Host both build their links with controllerPath.
    expect(linkedSession(origin + controllerPath({ hostId: 'host-1', providerId: 'claude', nativeSessionId: 'native-1' }))).toBe('host-1/claude/native-1');
    // Through the latency proxy, and in Bot mode, a link names its session the same way.
    expect(linkedSession('http://127.0.0.1:9/?mode=bot&host=host-1&provider=codex&session=thread-1')).toBe('host-1/codex/thread-1');
  });
  it('is none for a link to a Window, whose sessions the run reads together', () => {
    expect(linkedSession(`${origin}/?window=group-1`)).toBeUndefined();
    expect(linkedSession(`${origin}/`)).toBeUndefined();
  });
  it('is found by the native session its conversation names, wherever the layout places it and whether or not it knows its Host', () => {
    expect(sessionPane('host-1/claude/native-1')).toBe('[data-native-session="claude/native-1"]');
    // The command line reads everything after the provider as the native id.
    expect(sessionPane('host-1/opencode/ses/1')).toBe('[data-native-session="opencode/ses/1"]');
  });
});

describe('the record a revisit paints from', () => {
  const relay = 'http://127.0.0.1:61630/';
  const keys = [deviceKey(relay, ['host-1', 'copilot', 'other-1']), deviceKey(relay, ['host-1', 'claude', 'native-2'])];
  it("is the opened session's own: a record of another session of the Window does not count", () => {
    expect(keptRecordOf(keys, 'host-1/claude/native-2')).toBe(true);
    expect(keptRecordOf(keys, 'host-1/claude/native-1')).toBe(false);
    expect(keptRecordOf(keys, 'host-1/codex/native-2')).toBe(false);
  });
  it('is any record for a page that opened a Window', () => {
    expect(keptRecordOf(keys, undefined)).toBe(true);
    expect(keptRecordOf([], undefined)).toBe(false);
  });
});
