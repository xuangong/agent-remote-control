import { describe, expect, it } from 'vitest';
import { controllerPath } from '@orchardworks/agent-remote-protocol/model';
import { linkedSession, sessionPane } from './probe.js';

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
