import { result, type InvariantResult, type PageReport, type Transcript, type Violation } from './types.js';
import { payloadOf, received, sent } from './wire.js';

/** M1: a revisit paints its first rows from the device store within the limit of the document's arrival (the document's own trip takes as long as the network does), whatever the network does. An open that shows no rows at all within its deadline fails too. */
export function firstPaintFromDeviceStore(page: PageReport, limitMs = 300): InvariantResult {
  const stored = page.paints.filter(paint => paint.fromDeviceStore);
  const violations: Violation[] = stored.filter(paint => paint.ms > limitMs)
    .map(paint => ({ message: `${paint.label}: first rows from the device store took ${paint.ms} ms after the document arrived, over ${limitMs} ms`, detail: paint }));
  const timedOut = page.paints.filter(paint => paint.timedOut);
  for (const paint of timedOut) violations.push({ message: `${paint.label}: no rows within ${paint.ms} ms`, detail: paint });
  const slowRevisits = page.paints.filter(paint => !paint.fromDeviceStore && !paint.timedOut && /revisit/.test(paint.label));
  for (const paint of slowRevisits) violations.push({ message: `${paint.label}: the first rows came ${paint.ms} ms after the document, after the Relay's first page, not from the device store`, detail: paint });
  return result('first-paint-from-device-store', stored.length + slowRevisits.length + timedOut.length, violations);
}

/**
 * M1: every message the page sent is settled exactly once, by an acknowledgement or an error carrying its request id.
 * With `final`, a send that never settled is a violation too; without it the run is still in flight.
 */
export function messagesSettleOnce(transcript: Transcript, { final = true }: { final?: boolean } = {}): InvariantResult {
  const settles = new Map<string, number>();
  for (const frame of received(transcript)) {
    const requestId = payloadOf(frame.message).requestId;
    if (typeof requestId !== 'string') continue;
    if (frame.message.type === 'command_acknowledged' || frame.message.type === 'protocol_error') settles.set(requestId, (settles.get(requestId) ?? 0) + 1);
  }
  const violations: Violation[] = [];
  const startedByOperation = new Map<string, string[]>();
  const sends = sent(transcript, 'send_message');
  for (const frame of sends) {
    const { requestId, operationId } = payloadOf(frame.message);
    const count = settles.get(requestId) ?? 0;
    if (count > 1) violations.push({ message: `send ${requestId} was settled ${count} times`, at: frame.t });
    if (count === 0 && final) violations.push({ message: `send ${requestId} never settled`, at: frame.t });
    if (typeof operationId === 'string') startedByOperation.set(operationId, [...(startedByOperation.get(operationId) ?? []), requestId]);
  }
  // A retry reuses the operation id with a new request id; the Controller may accept the operation only once.
  for (const [operationId, requestIds] of startedByOperation) {
    const accepted = received(transcript, 'command_acknowledged')
      .filter(frame => requestIds.includes(payloadOf(frame.message).requestId) && payloadOf(frame.message).inputAcceptance?.disposition === 'started');
    if (accepted.length > 1) violations.push({ message: `operation ${operationId} started ${accepted.length} times`, at: accepted[1]!.t });
  }
  return result('message-settles-once', sends.length, violations);
}

/** M1: no item key appears twice in one timeline page, or twice in the keys the page rendered at one moment. */
export function noDuplicateItemKey(transcript: Transcript, page: PageReport): InvariantResult {
  const violations: Violation[] = [];
  let checked = 0;
  for (const frame of received(transcript, 'timeline_page')) {
    const keys: string[] = (payloadOf(frame.message).entries ?? []).map((entry: { itemKey?: string }) => entry.itemKey).filter(Boolean);
    checked += keys.length;
    const duplicate = keys.find((key, at) => keys.indexOf(key) !== at);
    if (duplicate) violations.push({ message: `timeline page repeats item key ${duplicate}`, at: frame.t });
  }
  page.rowKeys.forEach((keys, snapshot) => {
    checked += keys.length;
    const duplicate = keys.find((key, at) => keys.indexOf(key) !== at);
    if (duplicate) violations.push({ message: `the page rendered item key ${duplicate} twice (snapshot ${snapshot})` });
  });
  return result('no-duplicate-item-key', checked, violations);
}
