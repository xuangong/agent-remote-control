import type { AgentSession } from '@orchardworks/agent-provider-sdk';
import type { SessionWireAgent } from '@orchardworks/agent-session-runtime';
import { describe, expect, it } from 'vitest';

import { createAttachmentLedger } from './attachment-ledger.js';

const session = (name: string) => ({ name }) as unknown as AgentSession;
const agent = () => ({}) as SessionWireAgent;

describe('attachment ledger', () => {
  it('hands a staged projection session to the Relay exactly once', () => {
    const ledger = createAttachmentLedger();
    const staged = session('a');
    ledger.stageProjection('agent-1', staged);
    expect(ledger.takeProjection('agent-1')).toBe(staged);
    expect(ledger.takeProjection('agent-1')).toBeUndefined();
  });

  it('keeps projections of different agents apart', () => {
    const ledger = createAttachmentLedger();
    const a = session('a'), b = session('b');
    ledger.stageProjection('agent-1', a);
    ledger.stageProjection('agent-2', b);
    expect(ledger.takeProjection('agent-2')).toBe(b);
    expect(ledger.takeProjection('agent-1')).toBe(a);
    expect(ledger.takeProjection('agent-3')).toBeUndefined();
  });

  it('discards a staged session only while it is the one given', () => {
    const ledger = createAttachmentLedger();
    const first = session('first'), second = session('second');
    ledger.stageProjection('agent-1', second);
    expect(ledger.discardProjection('agent-1', first)).toBe(false);
    expect(ledger.takeProjection('agent-1')).toBe(second);
    ledger.stageProjection('agent-1', first);
    expect(ledger.discardProjection('agent-1', first)).toBe(true);
    expect(ledger.takeProjection('agent-1')).toBeUndefined();
  });

  it('discards whatever is staged when no session is given, and says nothing was staged otherwise', () => {
    const ledger = createAttachmentLedger();
    ledger.stageProjection('agent-1', session('a'));
    expect(ledger.discardProjection('agent-1')).toBe(true);
    expect(ledger.takeProjection('agent-1')).toBeUndefined();
    expect(ledger.discardProjection('agent-1')).toBe(false);
  });

  it('reads a native attachment back by the agent it was recorded for', () => {
    const ledger = createAttachmentLedger();
    const one = agent(), two = agent();
    const attachment = { session: session('native'), nativeCreation: 'creation-1', nativePrefix: 'prefix-1' };
    ledger.recordAttachment(one, attachment);
    expect(ledger.attachmentOf(one)).toBe(attachment);
    expect(ledger.attachmentOf(two)).toBeUndefined();
  });

  it('replaces the attachment of an agent that is attached again', () => {
    const ledger = createAttachmentLedger();
    const one = agent();
    ledger.recordAttachment(one, { session: session('old') });
    const next = { session: session('new') };
    ledger.recordAttachment(one, next);
    expect(ledger.attachmentOf(one)).toBe(next);
  });

  it('has no worker tools applied to an agent never recorded, and keeps the latest record', () => {
    const ledger = createAttachmentLedger();
    expect(ledger.workerToolsApplied('agent-1')).toBe(false);
    ledger.recordWorkerTools('agent-1', true);
    expect(ledger.workerToolsApplied('agent-1')).toBe(true);
    expect(ledger.workerToolsApplied('agent-2')).toBe(false);
    ledger.recordWorkerTools('agent-1', false);
    expect(ledger.workerToolsApplied('agent-1')).toBe(false);
  });

  it('keeps an agent uncertain from the mark until it is cleared, and no other agent with it', () => {
    const ledger = createAttachmentLedger();
    expect(ledger.isUncertain('agent-1')).toBe(false);
    ledger.markUncertain('agent-1');
    expect(ledger.isUncertain('agent-1')).toBe(true);
    expect(ledger.isUncertain('agent-2')).toBe(false);
    ledger.markUncertain('agent-1');
    ledger.clearUncertain('agent-1');
    expect(ledger.isUncertain('agent-1')).toBe(false);
  });
});
