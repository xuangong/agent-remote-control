import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { decodeDshTrace, encodeDshTrace } from './codec.js';
import { DshTraceRecorder } from './recorder.js';
import { DshRecordingPlugin } from './recording-plugin.js';
import type { DshTrace } from './schema.js';

function trace(): DshTrace {
  return {
    header: {
      type: 'trace_header',
      format: 'borgee.dsh.trace.v1',
      sessionId: 'trace-session',
      nativeSessionHeader: { protocol: 'dsh', extensions: ['rich-content'] },
      runtimeInfo: { status: 'waiting', model: { id: 'test-model' } },
    },
    records: [
      {
        type: 'native_record',
        ordinal: 1,
        offset: 0,
        recordId: 'native-1',
        kind: 'session_event',
        payload: {
          type: 'user/message',
          data: {
            id: 'message-1',
            source: { kind: 'user' },
            content: [{ type: 'text', text: 'Keep every JSON value.', future: { enabled: true, value: null } }],
          },
        },
      },
      {
        type: 'native_record',
        ordinal: 2,
        offset: 25,
        recordId: 'native-2',
        kind: 'interaction_requested',
        payload: {
          request: {
            kind: 'tool_approval', requestId: 'permission-1', toolCallId: 'call-1', toolName: 'read',
            summary: 'Read the workspace?', detail: { type: 'other', description: 'Read the workspace?' },
            allowedDecisions: ['allow', 'deny'], allowScopes: ['once'],
          },
        },
      },
    ],
  };
}

describe('DSH trace codec', () => {
  it('round-trips ordered raw JSON payloads without changing their values', () => {
    const original = trace();

    const decoded = decodeDshTrace(encodeDshTrace(original));

    expect(decoded).toEqual(original);
    expect(decoded.records[0]?.payload).toEqual({
      type: 'user/message',
      data: {
        id: 'message-1',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Keep every JSON value.', future: { enabled: true, value: null } }],
      },
    });
  });

  it.each([
    ['a truncated final line', '{"type":"trace_header"}\n{"type":"native_record"'],
    ['a record before the header', '{"type":"native_record","ordinal":1,"offset":0,"recordId":"one","kind":"session_event","payload":{}}\n'],
    ['an ordinal regression', [
      '{"type":"trace_header","format":"borgee.dsh.trace.v1","sessionId":"trace-session","nativeSessionHeader":{},"runtimeInfo":{}}',
      '{"type":"native_record","ordinal":2,"offset":0,"recordId":"one","kind":"session_event","payload":{}}',
      '{"type":"native_record","ordinal":2,"offset":1,"recordId":"two","kind":"session_event","payload":{}}',
      '',
    ].join('\n')],
    ['an offset regression', [
      '{"type":"trace_header","format":"borgee.dsh.trace.v1","sessionId":"trace-session","nativeSessionHeader":{},"runtimeInfo":{"status":"waiting"}}',
      '{"type":"native_record","ordinal":1,"offset":2,"recordId":"one","kind":"session_event","payload":{}}',
      '{"type":"native_record","ordinal":2,"offset":1,"recordId":"two","kind":"session_event","payload":{}}',
      '',
    ].join('\n')],
  ])('rejects %s', (_description, input) => {
    expect(() => decodeDshTrace(input)).toThrow(/trace/i);
  });

  it('records immutable raw snapshots through the DSH recording plugin', () => {
    const recorder = new DshTraceRecorder(trace().header);
    const plugin = new DshRecordingPlugin(recorder);
    const payload = { type: 'user/message', data: { id: 'message-2', content: [{ type: 'text', text: 'original' }] } };

    plugin.record({ recordId: 'native-plugin', occurredAt: 120, kind: 'session_event', payload });
    (payload.data.content[0] as { text: string }).text = 'changed later';

    expect(recorder.trace.records).toEqual([{
      type: 'native_record',
      ordinal: 1,
      offset: 0,
      recordId: 'native-plugin',
      kind: 'session_event',
      payload: { type: 'user/message', data: { id: 'message-2', content: [{ type: 'text', text: 'original' }] } },
    }]);
  });

  it('retains parsed __proto__ keys as raw data without changing Object.prototype', () => {
    const nativeSessionHeader = JSON.parse('{"__proto__":{"headerPolluted":true},"protocol":"dsh"}');
    const payload = JSON.parse('{"__proto__":{"payloadPolluted":true},"safe":1}');
    const recorder = new DshTraceRecorder({
      ...trace().header,
      nativeSessionHeader,
    });

    recorder.record({ recordId: 'proto-record', occurredAt: 10, kind: 'session_event', payload });
    const recordedHeader = recorder.trace.header.nativeSessionHeader as Record<string, unknown>;
    const recordedPayload = recorder.trace.records[0]?.payload as Record<string, unknown>;

    expect(Object.hasOwn(recordedHeader, '__proto__')).toBe(true);
    expect(Object.hasOwn(recordedPayload, '__proto__')).toBe(true);
    expect(recordedHeader.__proto__).toEqual({ headerPolluted: true });
    expect(recordedPayload.__proto__).toEqual({ payloadPolluted: true });
    expect((Object.prototype as Record<string, unknown>).headerPolluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).payloadPolluted).toBeUndefined();
    expect(decodeDshTrace(encodeDshTrace(recorder.trace)).records[0]?.payload).toEqual(payload);
  });

  it('rejects non-data objects instead of invoking custom JSON conversion', () => {
    const custom = Object.create({ toJSON: () => ({ changed: true }) }) as { safe: number };
    custom.safe = 1;
    const arrayWithHiddenValue = [1];
    Object.defineProperty(arrayWithHiddenValue, 'hidden', { value: 'discarded' });
    const recorder = new DshTraceRecorder(trace().header);

    expect(() => recorder.record({ recordId: 'date-record', occurredAt: 10, kind: 'session_event', payload: new Date() as never })).toThrow(/JSON/);
    expect(() => recorder.record({ recordId: 'custom-record', occurredAt: 11, kind: 'session_event', payload: custom })).toThrow(/JSON/);
    expect(() => recorder.record({ recordId: 'array-record', occurredAt: 12, kind: 'session_event', payload: arrayWithHiddenValue })).toThrow(/JSON/);
    expect(() => encodeDshTrace({
      ...trace(),
      header: { ...trace().header, nativeSessionHeader: new Date() as never },
    })).toThrow(/JSON/);
  });

  it.each([
    ['basic-tool.dsh-trace.ndjson', 6],
    ['correction-rich-unknown.dsh-trace.ndjson', 5],
  ])('decodes the selected %s fixture in its recorded order', (fixture, expectedRecords) => {
    const input = readFileSync(new URL(`../../fixtures/${fixture}`, import.meta.url), 'utf8');

    const decoded = decodeDshTrace(input);

    expect(decoded.records).toHaveLength(expectedRecords);
    expect(decoded.records.map((record) => record.ordinal)).toEqual(Array.from({ length: expectedRecords }, (_, index) => index + 1));
  });
});
