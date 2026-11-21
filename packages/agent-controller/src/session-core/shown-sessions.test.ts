import { describe, expect, it } from 'vitest';

import { createShownSessions } from './shown-sessions.js';
import type { SessionBinding } from './types.js';

function harness(bindings: SessionBinding[]) {
  const shown = new Map<string, boolean>();
  const sessions = createShownSessions({ bindings: () => bindings, show: (agentId, value) => { shown.set(agentId, value); } });
  return { sessions, shown, bindings };
}
const binding = (agentId: string, providerId: string, nativeSessionId: string): SessionBinding => ({ agentId, providerId, nativeSessionId });

describe('the sessions pages show', () => {
  it('marks each bound session shown or not, from the complete set the Relay sent', () => {
    const { sessions, shown } = harness([binding('a', 'codex', 'thread-1'), binding('b', 'claude', 'thread-1'), binding('c', 'codex', 'thread-2')]);
    sessions.update(['codex:thread-1', 'claude:thread-1']);
    expect(Object.fromEntries(shown)).toEqual({ a: true, b: true, c: false });
  });

  it('replaces the set before: a session the new set leaves out is no longer shown', () => {
    const { sessions, shown } = harness([binding('a', 'codex', 'thread-1'), binding('c', 'codex', 'thread-2')]);
    sessions.update(['codex:thread-1']);
    sessions.update(['codex:thread-2']);
    expect(Object.fromEntries(shown)).toEqual({ a: false, c: true });
    sessions.update([]);
    expect(Object.fromEntries(shown)).toEqual({ a: false, c: false });
  });

  it('keeps a key whose session is not bound yet, and marks the session when it is attached', () => {
    const { sessions, shown, bindings } = harness([]);
    sessions.update(['codex:thread-1']);
    expect(shown.size).toBe(0);
    const later = binding('a', 'codex', 'thread-1');
    bindings.push(later);
    sessions.apply(later);
    expect(shown.get('a')).toBe(true);
    sessions.apply(binding('b', 'codex', 'thread-9'));
    expect(shown.get('b')).toBe(false);
  });

  it('reads a native session id that holds a colon as one id after the provider', () => {
    const { sessions, shown } = harness([binding('a', 'dsh', 'workspace:session-1')]);
    sessions.update(['dsh:workspace:session-1']);
    expect(shown.get('a')).toBe(true);
  });
});
