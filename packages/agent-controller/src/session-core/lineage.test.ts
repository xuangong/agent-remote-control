import type { AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { genericSuccessionSource, originalCreation, originalNativePrefix, type LineageStore } from './lineage.js';

const ref = (nativeSessionId: string, providerId = 'codex'): NativeSessionRef => ({ controllerId: 'controller-1', providerId, nativeSessionId });
const handle = (sessionId: string, opaque = 'opaque'): AgentPersistenceHandle => ({ providerId: 'codex', sessionId, opaque });

interface Operation { operationId: string; from: NativeSessionRef; to?: NativeSessionRef; preparation?: unknown }
interface Progress { orphanCandidate?: NativeSessionRef; nativeCreation?: { outcome?: unknown }; nativePrefix?: { handle?: AgentPersistenceHandle } }

/** A store of records: each operation with the progress the Controller kept for it. */
const store = (...rows: Array<[Operation, Progress?]>): LineageStore => ({
  all: () => [{ operations: rows.map(([operation]) => operation) }] as unknown as ReturnType<LineageStore['all']>,
  progress: operationId => rows.find(([operation]) => operation.operationId === operationId)?.[1] as ReturnType<LineageStore['progress']>,
});
const operation = (operationId: string, from: string, to?: string, preparation?: unknown): Operation => ({ operationId, from: ref(from), ...(to ? { to: ref(to) } : {}), ...(preparation ? { preparation } : {}) });
const created = (sessionId: string) => ({ status: 'created', handle: handle(sessionId) });

describe('original creation', () => {
  it('answers the native creation result of the candidate an operation created', () => {
    expect(originalCreation(store([operation('op', 'a', 'b'), { nativeCreation: { outcome: created('b') } }]), ref('b'))).toEqual(created('b'));
  });

  it('answers the orphan candidate of an operation that did not commit', () => {
    expect(originalCreation(store([operation('op', 'a'), { orphanCandidate: ref('b'), nativeCreation: { outcome: created('b') } }]), ref('b'))).toEqual(created('b'));
  });

  it('answers nothing for a target no operation names, for operations without creation evidence, and without a store', () => {
    expect(originalCreation(store([operation('op', 'a', 'b'), { nativeCreation: { outcome: created('b') } }]), ref('c'))).toBeUndefined();
    expect(originalCreation(store([operation('op', 'a', 'b'), {}]), ref('b'))).toBeUndefined();
    expect(originalCreation(undefined, ref('b'))).toBeUndefined();
  });

  it.each([['no outcome', {}], ['a creation that was never dispatched', { outcome: { status: 'not_dispatched' } }]])('refuses evidence with %s', (_name, nativeCreation) => {
    expect(() => originalCreation(store([operation('op', 'a', 'b'), { nativeCreation }]), ref('b'))).toThrow('Native creation evidence is not resumable.');
  });

  it('refuses a result that does not authorize the attachment', () => {
    expect(() => originalCreation(store([operation('op', 'a', 'b'), { nativeCreation: { outcome: created('other') } }]), ref('b'))).toThrow();
  });

  it('accepts two operations that agree and refuses two that disagree', () => {
    const agree = store([operation('one', 'a', 'b'), { nativeCreation: { outcome: created('b') } }], [operation('two', 'c', 'b'), { nativeCreation: { outcome: created('b') } }]);
    expect(originalCreation(agree, ref('b'))).toEqual(created('b'));
    const differ = store([operation('one', 'a', 'b'), { nativeCreation: { outcome: created('b') } }],
      [operation('two', 'c', 'b'), { nativeCreation: { outcome: { status: 'created', handle: { ...handle('b'), opaque: 'another' } } } }]);
    expect(() => originalCreation(differ, ref('b'))).toThrow('Native creation attachment identity conflicts.');
  });
});

describe('original native prefix', () => {
  const prefix = { turnId: 't', messageId: 'm' };

  it('answers the saved handle and the source of a prompt edit', () => {
    expect(originalNativePrefix(store([operation('op', 'a', 'b', prefix), { nativePrefix: { handle: handle('b') } }]), ref('b'))).toEqual({ handle: handle('b'), source: ref('a') });
  });

  it('answers nothing for an operation that is not a prompt edit, and without a store', () => {
    expect(originalNativePrefix(store([operation('op', 'a', 'b'), { nativePrefix: { handle: handle('b') } }]), ref('b'))).toBeUndefined();
    expect(originalNativePrefix(undefined, ref('b'))).toBeUndefined();
  });

  it('refuses a prompt edit whose handle was not saved, or that also holds a creation result', () => {
    expect(() => originalNativePrefix(store([operation('op', 'a', 'b', prefix), {}]), ref('b'))).toThrow('Original native prefix evidence is unavailable.');
    expect(() => originalNativePrefix(store([operation('op', 'a', 'b', prefix), { nativePrefix: { handle: handle('b') }, nativeCreation: { outcome: created('b') } }]), ref('b'))).toThrow('Original native prefix evidence is unavailable.');
  });

  it('refuses two operations that name different sources or handles', () => {
    const sources = store([operation('one', 'a', 'b', prefix), { nativePrefix: { handle: handle('b') } }], [operation('two', 'c', 'b', prefix), { nativePrefix: { handle: handle('b') } }]);
    expect(() => originalNativePrefix(sources, ref('b'))).toThrow('Native prefix attachment identity conflicts.');
    const handles = store([operation('one', 'a', 'b', prefix), { nativePrefix: { handle: handle('b') } }], [operation('two', 'a', 'b', prefix), { nativePrefix: { handle: handle('b', 'another') } }]);
    expect(() => originalNativePrefix(handles, ref('b'))).toThrow('Native prefix attachment identity conflicts.');
  });
});

describe('generic succession source', () => {
  it('answers the source of a generic successor, pending or committed', () => {
    expect(genericSuccessionSource(store([operation('op', 'a', 'b')]), ref('b'))).toEqual(ref('a'));
    expect(genericSuccessionSource(store([operation('op', 'a'), { orphanCandidate: ref('b') }]), ref('b'))).toEqual(ref('a'));
  });

  it('answers nothing for a prompt edit, an unnamed target and without a store', () => {
    expect(genericSuccessionSource(store([operation('op', 'a', 'b', { turnId: 't', messageId: 'm' })]), ref('b'))).toBeUndefined();
    expect(genericSuccessionSource(store([operation('op', 'a', 'b')]), ref('c'))).toBeUndefined();
    expect(genericSuccessionSource(undefined, ref('b'))).toBeUndefined();
  });

  it('accepts the same source twice and refuses two sources', () => {
    expect(genericSuccessionSource(store([operation('one', 'a', 'b')], [operation('two', 'a', 'b')]), ref('b'))).toEqual(ref('a'));
    expect(() => genericSuccessionSource(store([operation('one', 'a', 'b')], [operation('two', 'c', 'b')]), ref('b'))).toThrow('Generic succession source identity conflicts.');
  });
});
