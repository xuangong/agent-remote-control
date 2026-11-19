import { describe, expect, it } from 'vitest';
import { page, sample, tailPage, transcript } from './builders.js';
import { catchUpCostsOneTailRequest, draftAndPositionKept, halfOpenSocketRecovers, noBlankFrame, noSessionConnectionLabel } from './page.js';

describe('no blank frame', () => {
  it('passes when the conversation stays or a placeholder covers the gap', () => {
    const report = page({ samples: [sample(0), sample(100, { messages: 0, entries: 0, loading: ['Loading session'] }), sample(200)] });
    expect(noBlankFrame(report).status).toBe('passed');
  });
  it('fails when the conversation empties with no placeholder or held rows, whatever label shows', () => {
    const report = page({ samples: [sample(0), sample(100, { messages: 0, entries: 0, labels: ['Ready'] }), sample(200)] });
    expect(noBlankFrame(report).violations[0]?.at).toBe(100);
  });
});

describe('no session connection label', () => {
  it('passes samples that say Ready or Working', () => {
    const report = page({ samples: [sample(100, { labels: ['Ready'] }), sample(200, { labels: ['Working'] }), sample(300, { labels: [] })] });
    expect(noSessionConnectionLabel(report).status).toBe('passed');
  });
  it('fails at the time a sample says Synchronizing, or any other connection word', () => {
    const report = page({ samples: [sample(100), sample(1500, { labels: ['Synchronizing'] }), sample(2000, { labels: ['Reconnect'] })] });
    const found = noSessionConnectionLabel(report);
    expect(found.status).toBe('failed');
    expect(found.violations.map(violation => violation.at)).toEqual([1500, 2000]);
    expect(found.violations[0]?.message).toMatch(/Synchronizing/);
  });
  it('passes Host offline, which is a business fact', () => {
    expect(noSessionConnectionLabel(page({ samples: [sample(100, { labels: ['Host offline'] })] })).status).toBe('passed');
  });
  it('is not exercised by an empty report', () => {
    expect(noSessionConnectionLabel(page()).status).toBe('not_exercised');
  });
});

describe('catch-up costs one tail request', () => {
  const returned = () => transcript().marker(0, 'page-hidden').marker(10, 'page-visible');
  it('passes with one tail request per session after the page returns', () => {
    const wire = returned().send(11, 'timeline_request', { agentId: 'a', direction: 'tail', limit: 100 }).receive(12, 'timeline_page', tailPage('e1', 1, 3)).build();
    expect(catchUpCostsOneTailRequest(wire).status).toBe('passed');
  });
  it('fails with a second tail request for the same session', () => {
    const wire = returned().send(11, 'timeline_request', { agentId: 'a', direction: 'tail' }).send(12, 'timeline_request', { agentId: 'a', direction: 'tail' }).build();
    expect(catchUpCostsOneTailRequest(wire).status).toBe('failed');
  });
});

describe('draft and reading position are kept', () => {
  const same = { before: { text: 'draft', focused: true }, after: { text: 'draft', focused: true } };
  it('passes when text and anchor are unchanged', () => {
    const report = page({ composer: same, anchor: { before: { key: 'k5', offset: 40 }, after: { key: 'k5', offset: 41 } } });
    expect(draftAndPositionKept(report).status).toBe('passed');
  });
  it('fails when the draft changed or the reader moved to another row', () => {
    expect(draftAndPositionKept(page({ composer: { ...same, after: { text: '', focused: false } } })).status).toBe('failed');
    expect(draftAndPositionKept(page({ anchor: { before: { key: 'k5', offset: 40 }, after: { key: 'k9', offset: 40 } } })).status).toBe('failed');
    expect(draftAndPositionKept(page({ anchor: { before: { key: 'k5', offset: 40 }, after: null } })).status).toBe('failed');
  });
});

describe('a half-open socket is replaced', () => {
  const faulted = () => transcript().marker(1000, 'fault', { kind: 'half-open' });
  it('passes when the session is negotiated again within the limit', () => {
    expect(halfOpenSocketRecovers(faulted().marker(9000, 'socket-open', undefined, 2).receive(9100, 'negotiated').build(), 30_000).status).toBe('passed');
  });
  it('fails when only another channel reopened, or the session came back after the limit', () => {
    const accountOnly = faulted().marker(1500, 'socket-open', undefined, 4).receive(1600, 'session_states').build();
    expect(halfOpenSocketRecovers(accountOnly).violations[0]?.message).toMatch(/never served again/);
    expect(halfOpenSocketRecovers(faulted().receive(70_000, 'negotiated').build(), 30_000).violations[0]?.message).toMatch(/took 69000 ms/);
  });
});
