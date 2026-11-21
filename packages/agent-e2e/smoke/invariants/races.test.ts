import { describe, expect, it } from 'vitest';
import { page, transcript } from './builders.js';
import { carrying, everyWriterSends, mergePageReports, noLostOrDoubledMessage, pageDelivery, pageStaysLiveWhenCodexRefuses, stateAndPropertiesMatch, terminalRowsAppear } from './races.js';
import type { RoundRecord, ViewRecord, WriterRecord } from './types.js';

const ask = (word: string) => `Reply with the single word ${word} and nothing else.`;
const writer = (name: string, word: string, extra: Partial<WriterRecord> = {}): WriterRecord => ({ writer: name, word, delivered: true, tries: 1, ...extra });
const view = (name: string, words: string[], extra: Partial<ViewRecord> = {}): ViewRecord => ({ name, userTexts: words.map(ask), status: 'idle', ...extra });
/** A round where a page and a terminal each sent one message, and the native session and the page both show both. */
const round = (extra: Partial<RoundRecord> = {}): RoundRecord => ({
  label: 'codex terminal 1', writers: [writer('page', 'PAGE1'), writer('terminal', 'TERM1')],
  native: view('native', ['READY', 'PAGE1', 'TERM1']), pages: [view('page', ['READY', 'PAGE1', 'TERM1'])], ...extra,
});

describe('a message is carried by its word', () => {
  it('counts the messages that carry the word as a word of their own', () => {
    expect(carrying([ask('PAGE1'), ask('PAGE12'), 'PAGE1, again'], 'PAGE1')).toBe(2);
  });
});

describe('no message is lost or doubled, on the native session and on every page', () => {
  it('passes when every place shows each message once', () => {
    expect(noLostOrDoubledMessage([round()])).toMatchObject({ status: 'passed', checked: 4 });
  });
  it('fails for a message a place lost, one it doubled, and one shown although its writer was told it was refused', () => {
    const lost = noLostOrDoubledMessage([round({ native: view('native', ['READY', 'PAGE1']) })]);
    expect(lost.violations.map(item => item.message)).toEqual(["[codex terminal 1] native lost the terminal's message TERM1"]);
    const doubled = noLostOrDoubledMessage([round({ pages: [view('page', ['PAGE1', 'TERM1', 'PAGE1'])] })]);
    expect(doubled.violations[0]?.message).toMatch(/page shows the page's message PAGE1 2 times/);
    const refused = noLostOrDoubledMessage([round({ writers: [writer('page', 'PAGE1'), writer('terminal', 'TERM1', { delivered: false, refusal: 'thread already has an active turn' })] })]);
    expect(refused.violations).toHaveLength(2);
    expect(refused.violations[0]?.message).toMatch(/which its writer was told was refused \(thread already has an active turn\)/);
  });
  it('passes for a refused message that no place shows', () => {
    const refused = round({ writers: [writer('page', 'PAGE1'), writer('terminal', 'TERM1', { delivered: false })], native: view('native', ['PAGE1']), pages: [view('page', ['PAGE1'])] });
    expect(noLostOrDoubledMessage([refused]).status).toBe('passed');
  });
  it('is not exercised by a run that recorded no round', () => {
    expect(noLostOrDoubledMessage([]).status).toBe('not_exercised');
  });
});

describe('every writer sends', () => {
  it('passes when each message was taken, after any tries Codex asked for', () => {
    expect(everyWriterSends([round({ writers: [writer('page', 'PAGE1'), writer('terminal', 'TERM1', { tries: 3 })] })]).status).toBe('passed');
  });
  it('fails for a writer that could not send, with what it was told', () => {
    const failed = everyWriterSends([round({ writers: [writer('page', 'PAGE1', { delivered: false, tries: 1, refusal: 'native_session_owned: A terminal holds this session.' })] })]);
    expect(failed.violations[0]?.message).toBe('[codex terminal 1] the page could not send PAGE1 in 1 tries: native_session_owned: A terminal holds this session.');
  });
});

describe("a terminal's turn appears on every page by itself", () => {
  it('passes when each page showed it within the bound', () => {
    expect(terminalRowsAppear([round({ terminalShown: { boundMs: 30_000, afterMs: [1200] } })])).toMatchObject({ status: 'passed', checked: 1 });
  });
  it('fails for a page that never showed it, and is not exercised by rounds with no terminal', () => {
    expect(terminalRowsAppear([round({ terminalShown: { boundMs: 30_000, afterMs: [null] } })]).violations[0]?.message).toBe("[codex terminal 1] the terminal's turn did not appear on page within 30000 ms");
    expect(terminalRowsAppear([round()]).status).toBe('not_exercised');
  });
});

describe('every page shows the state and properties of the native session', () => {
  const settings = { Model: 'GPT-6-Astra', 'Reasoning effort': 'medium' };
  it('passes when every page says what the native session says', () => {
    const same = round({ native: view('native', [], { settings }), pages: [view('page', [], { settings }), view('second page', [], { settings: { ...settings, Usage: '12k' } })] });
    expect(stateAndPropertiesMatch([same])).toMatchObject({ status: 'passed', checked: 6 });
  });
  it('fails for an activity, a setting or a missing activity that differs from the native session', () => {
    const differing = round({ native: view('native', [], { status: 'idle', settings }), pages: [view('page', [], { status: 'running', settings: { ...settings, 'Reasoning effort': 'low' } }), view('second page', [], { status: undefined, settings: { Model: 'GPT-6-Astra' } })] });
    expect(stateAndPropertiesMatch([differing]).violations.map(item => item.message)).toEqual([
      '[codex terminal 1] page says running, the native session idle',
      '[codex terminal 1] page shows Reasoning effort "low", the native session "medium"',
      '[codex terminal 1] second page shows no activity',
      '[codex terminal 1] second page shows Reasoning effort nowhere, the native session "medium"',
    ]);
  });
  it("fails for a page of the session's live events that never said it was working while the terminal's turn ran", () => {
    expect(stateAndPropertiesMatch([round({ liveState: { seenWorking: [true] } })]).status).toBe('passed');
    expect(stateAndPropertiesMatch([round({ liveState: { seenWorking: [false] } })]).violations[0]?.message).toBe("[codex terminal 1] page never said the session was working while the terminal's turn ran");
  });
});

describe("a page's message as its writer was told", () => {
  const sendFrame = (t: number, requestId: string, word: string) => ({ requestId, operationId: 'op-1', agentId: 'agent', text: ask(word) });
  it('is taken when the Relay acknowledged one of its sends', () => {
    const wire = transcript().send(1, 'send_message', sendFrame(1, 'r1', 'PAGE1')).receive(2, 'command_acknowledged', { requestId: 'r1', inputAcceptance: { disposition: 'queued' } })
      .send(3, 'send_message', sendFrame(3, 'r2', 'OTHER')).build();
    expect(pageDelivery(wire, 'PAGE1')).toEqual({ delivered: true, tries: 1 });
  });
  it('is answered on its own socket: another page that counts the same request id does not answer it', () => {
    const wire = transcript().send(1, 'send_message', sendFrame(1, 'r1', 'PAGE1')).onConnection(2).send(2, 'send_message', sendFrame(2, 'r1', 'PAGE2'))
      .receive(3, 'command_acknowledged', { requestId: 'r1', inputAcceptance: { disposition: 'started' } }).build();
    expect(pageDelivery(wire, 'PAGE1')).toEqual({ delivered: false, tries: 1 });
    expect(pageDelivery(wire, 'PAGE2')).toEqual({ delivered: true, tries: 1 });
  });
  it('is refused with the code and words of the last error, and never sent when no send carried it', () => {
    const wire = transcript().send(1, 'send_message', sendFrame(1, 'r1', 'PAGE1')).receive(2, 'protocol_error', { requestId: 'r1', code: 'native_session_owned', message: 'A terminal holds this session.' }).build();
    expect(pageDelivery(wire, 'PAGE1')).toEqual({ delivered: false, tries: 1, refusal: 'native_session_owned: A terminal holds this session.' });
    expect(pageDelivery(wire, 'PAGE2')).toEqual({ delivered: false, tries: 0 });
  });
});

describe('the pages of one condition read together', () => {
  it('keeps every sample, in time order, and every row', () => {
    const merged = mergePageReports([page({ samples: [{ t: 5, labels: [], loading: [], messages: 1, entries: 1, composer: 'enabled', delivery: [] }], finalRows: [{ key: 'a', kind: 'user_message', text: 'x' }] }),
      page({ samples: [{ t: 2, labels: ['Ready'], loading: [], messages: 1, entries: 1, composer: 'enabled', delivery: [] }] })]);
    expect(merged.samples.map(sample => sample.t)).toEqual([2, 5]);
    expect(merged.finalRows).toHaveLength(1);
  });
});

describe('the page stays live when Codex refuses the Controller for a separate process', () => {
  const live = { rows: 6, status: 'running', notice: 'Codex says another Codex process is writing this session (it already has an active writer).', retry: true, takeOver: false };
  const record = (shown: Partial<typeof live> = {}, caughtUpMs: number | null = 4000) => ({ label: 'codex separate process', shown: { ...live, ...shown }, caughtUpMs, boundMs: 90_000 });
  it("passes when the page keeps the content and activity, says Codex's reason, offers a Retry and catches up", () => {
    expect(pageStaysLiveWhenCodexRefuses([record()])).toMatchObject({ status: 'passed', checked: 5 });
  });
  it('fails for an empty page, no activity, a reason that is not Codex\'s, no Retry, and a turn that never arrives', () => {
    const shown = { rows: 0, status: undefined, notice: 'Read only Native CLI has control Interrupt & take over', retry: false, takeOver: true };
    expect(pageStaysLiveWhenCodexRefuses([record(shown, null)]).violations.map(item => item.message)).toEqual([
      "[codex separate process] the page showed none of the session's rows while Codex refused it",
      '[codex separate process] the page showed no activity while Codex refused it',
      '[codex separate process] the page did not say Codex\'s reason; it said "Read only Native CLI has control Interrupt & take over"',
      '[codex separate process] the page offered no Retry',
      "[codex separate process] the separate process's turn did not reach the page within 90000 ms of its end",
    ]);
  });
  it('is not exercised by a run that never met a separate process', () => {
    expect(pageStaysLiveWhenCodexRefuses([]).status).toBe('not_exercised');
  });
});
