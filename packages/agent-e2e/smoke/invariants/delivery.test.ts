import { describe, expect, it } from 'vitest';
import { page, tailPage, transcript } from './builders.js';
import { firstPaintFromDeviceStore, messagesSettleOnce, noDuplicateItemKey } from './delivery.js';

const send = (t: number, requestId: string, operationId = `op-${requestId}`) => ({ t, requestId, operationId });

describe('first paint from the device store', () => {
  it('passes when stored rows paint within the limit at any latency', () => {
    const verdict = firstPaintFromDeviceStore(page({ paints: [{ label: 'revisit at 1500 ms', ms: 120, fromDeviceStore: true }] }));
    expect(verdict.status).toBe('passed');
  });
  it('fails on a slow paint and on a revisit that was not painted from the store', () => {
    const slow = firstPaintFromDeviceStore(page({ paints: [{ label: 'revisit', ms: 900, fromDeviceStore: true }] }));
    const network = firstPaintFromDeviceStore(page({ paints: [{ label: 'revisit', ms: 40, fromDeviceStore: false }] }));
    expect([slow.status, network.status]).toEqual(['failed', 'failed']);
  });
  it('fails when a page shows no rows within its deadline', () => {
    const verdict = firstPaintFromDeviceStore(page({ paints: [{ label: 'revisit', ms: 90_000, fromDeviceStore: false, timedOut: true }] }));
    expect(verdict.violations[0]?.message).toMatch(/no rows within 90000 ms/);
  });
  it('is not exercised without a revisit', () => {
    expect(firstPaintFromDeviceStore(page({ paints: [{ label: 'first open', ms: 4000, fromDeviceStore: false }] })).status).toBe('not_exercised');
  });
});

describe('every message settles once', () => {
  const sendAndAck = (b = transcript()) => b.send(10, 'send_message', { requestId: 'r1', operationId: 'op1', agentId: 'agent', text: 'hi' })
    .receive(20, 'command_acknowledged', { requestId: 'r1', agentId: 'agent', command: 'send_message', inputAcceptance: { disposition: 'started' } });
  it('passes for one acknowledgement', () => {
    expect(messagesSettleOnce(sendAndAck().build()).status).toBe('passed');
  });
  it('fails for a send that never settled, unless the run is still in flight', () => {
    const open = transcript().send(10, 'send_message', send(10, 'r1')).build();
    expect(messagesSettleOnce(open).status).toBe('failed');
    expect(messagesSettleOnce(open, { final: false }).status).toBe('passed');
  });
  it('fails, also while the run is in flight, when a message the person sent never left the page', () => {
    const held = transcript().marker(5, 'turn-sent', { word: 'ZEPHYR1' }).build();
    expect(messagesSettleOnce(held).violations.map(v => v.message)).toEqual(['1 of 1 messages the person sent never left the page']);
    expect(messagesSettleOnce(held, { final: false }).status).toBe('failed');
    const retried = transcript().marker(5, 'turn-sent').send(10, 'send_message', send(10, 'r1', 'op1')).send(30, 'send_message', send(30, 'r2', 'op1'))
      .receive(40, 'command_acknowledged', { requestId: 'r2', agentId: 'agent', command: 'send_message' }).marker(50, 'turn-sent').build();
    expect(messagesSettleOnce(retried, { final: false }).violations.map(v => v.message)).toEqual(['1 of 2 messages the person sent never left the page']);
    expect(messagesSettleOnce(sendAndAck(transcript().marker(5, 'turn-sent')).build()).status).toBe('passed');
  });
  it('is not exercised when the person sent nothing', () => {
    expect(messagesSettleOnce([]).status).toBe('not_exercised');
  });
  it('fails for a doubled acknowledgement and for a retry the Controller started twice', () => {
    const doubled = sendAndAck().receive(30, 'command_acknowledged', { requestId: 'r1', agentId: 'agent', command: 'send_message' }).build();
    expect(messagesSettleOnce(doubled).violations[0]?.message).toMatch(/settled 2 times/);
    const retried = transcript()
      .send(10, 'send_message', send(10, 'r1', 'op1')).receive(20, 'command_acknowledged', { requestId: 'r1', agentId: 'agent', command: 'send_message', inputAcceptance: { disposition: 'started' } })
      .send(30, 'send_message', send(30, 'r2', 'op1')).receive(40, 'command_acknowledged', { requestId: 'r2', agentId: 'agent', command: 'send_message', inputAcceptance: { disposition: 'started' } }).build();
    expect(messagesSettleOnce(retried).violations.map(v => v.message)).toEqual(['operation op1 started 2 times']);
  });
  it('tells the requests of two pages apart, which count their request ids from the same start', () => {
    const twoPages = sendAndAck().onConnection(2).send(15, 'send_message', { requestId: 'r1', operationId: 'op2', agentId: 'agent', text: 'hi too' })
      .receive(25, 'command_acknowledged', { requestId: 'r1', agentId: 'agent', command: 'send_message', inputAcceptance: { disposition: 'queued' } }).build();
    expect(messagesSettleOnce(twoPages)).toMatchObject({ status: 'passed', checked: 2 });
    const unanswered = sendAndAck().onConnection(2).send(15, 'send_message', { requestId: 'r1', operationId: 'op2', agentId: 'agent', text: 'hi too' }).build();
    expect(messagesSettleOnce(unanswered).violations.map(v => v.message)).toEqual(['send r1 never settled']);
  });
});

describe('no duplicate item key', () => {
  it('passes when keys are unique on the wire and in the rendered rows', () => {
    const wire = transcript().receive(5, 'timeline_page', tailPage('e1', 1, 3)).build();
    expect(noDuplicateItemKey(wire, page({ rowKeys: [['k1', 'k2', 'k3']] })).status).toBe('passed');
  });
  it('fails for a repeated key in a page and in a rendered snapshot', () => {
    const entries = [{ itemKey: 'k1', seqStart: 1, seqEnd: 1 }, { itemKey: 'k1', seqStart: 2, seqEnd: 2 }];
    const wire = transcript().receive(5, 'timeline_page', tailPage('e1', 1, 2, { entries })).build();
    expect(noDuplicateItemKey(wire, page()).status).toBe('failed');
    expect(noDuplicateItemKey([], page({ rowKeys: [['a', 'b', 'a']] })).status).toBe('failed');
  });
});
