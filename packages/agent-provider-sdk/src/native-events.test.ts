import { describe, expect, it } from 'vitest';

import { readUnknownNativeEvent, unknownNativeEventLine } from './native-events.js';

describe('the diagnostic of a native event an adapter does not know', () => {
  it('names the provider, the kind, the delivery and why, and nothing of the content (U3)', () => {
    expect(JSON.parse(unknownNativeEventLine('codex', 'thread/hologram/updated', 'live'))).toEqual({ event: 'native_event_unknown', providerId: 'codex', kind: 'thread/hologram/updated', delivery: 'live', reason: 'unknown_kind' });
    expect(JSON.parse(unknownNativeEventLine('codex', 'turn/started', 'history', 'unreadable')).reason).toBe('unreadable');
  });

  it('bounds the kind at 128 characters and names one it cannot read', () => {
    expect(JSON.parse(unknownNativeEventLine('claude', 'k'.repeat(129), 'live')).kind).toHaveLength(128);
    expect(JSON.parse(unknownNativeEventLine('claude', 'k'.repeat(128), 'live')).kind).toHaveLength(128);
    expect(JSON.parse(unknownNativeEventLine('claude', undefined, 'live')).kind).toBe('(unnamed)');
  });

  it('is read back from its line, and no other line is taken for it', () => {
    const line = unknownNativeEventLine('copilot', 'session.hologram', 'history');
    expect(readUnknownNativeEvent(line)).toEqual({ event: 'native_event_unknown', providerId: 'copilot', kind: 'session.hologram', delivery: 'history', reason: 'unknown_kind' });
    expect(readUnknownNativeEvent('{"event":"native_process_exited","providerId":"claude"}')).toBeUndefined();
    expect(readUnknownNativeEvent('native_event_unknown, but not JSON')).toBeUndefined();
    expect(readUnknownNativeEvent(JSON.stringify({ event: 'native_event_unknown', providerId: 'x', kind: 'k', delivery: 'later', reason: 'unknown_kind' }))).toBeUndefined();
  });
});
