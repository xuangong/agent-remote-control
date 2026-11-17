import { describe, expect, it } from 'vitest';
import { page, sample, tailPage, transcript } from './builders.js';
import { catchUpCostsOneTailRequest, draftAndPositionKept, halfOpenSocketRecovers, noBlankFrame, noStaleLabel } from './page.js';

describe('no blank frame', () => {
  it('passes when the conversation stays or a placeholder covers the gap', () => {
    const report = page({ samples: [sample(0), sample(100, { messages: 0, entries: 0, loading: ['Loading session'] }), sample(200)] });
    expect(noBlankFrame(report).status).toBe('passed');
  });
  it('fails when the conversation empties with no placeholder and no label', () => {
    const report = page({ samples: [sample(0), sample(100, { messages: 0, entries: 0, labels: [] }), sample(200)] });
    expect(noBlankFrame(report).violations[0]?.at).toBe(100);
  });
});

describe('no stale label', () => {
  const answered = () => transcript().marker(0, 'socket-open', undefined, 1).receive(1000, 'negotiated');
  it('passes when the label clears soon after the Relay answers', () => {
    const report = page({ samples: [sample(1500, { labels: ['Synchronizing'] }), sample(3000)] });
    expect(noStaleLabel(answered().build(), report, 5000).status).toBe('passed');
  });
  it('passes when the connection closed after the answer, so reconnecting is true', () => {
    const wire = answered().marker(2000, 'socket-close', undefined, 1).build();
    expect(noStaleLabel(wire, page({ samples: [sample(9000, { labels: ['Reconnecting'] })] }), 5000).status).toBe('passed');
  });
  it('fails when "Reconnecting" stays long after the Relay answered on an open connection', () => {
    const report = page({ samples: [sample(9000, { labels: ['Reconnecting'] })] });
    expect(noStaleLabel(answered().build(), report, 5000).violations[0]?.message).toMatch(/Reconnecting/);
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
  it('passes when a new socket opens within the limit', () => {
    expect(halfOpenSocketRecovers(faulted().marker(9000, 'socket-open', undefined, 2).build(), 30_000).status).toBe('passed');
  });
  it('fails when no socket replaces it, or only after the limit', () => {
    expect(halfOpenSocketRecovers(faulted().build()).violations[0]?.message).toMatch(/never replaced/);
    expect(halfOpenSocketRecovers(faulted().marker(70_000, 'socket-open', undefined, 2).build(), 30_000).violations[0]?.message).toMatch(/took 69000 ms/);
  });
});
