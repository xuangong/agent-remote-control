import type { AgentSnapshotPayload } from '@orchardworks/agent-remote-protocol';
import { describe, expect, it } from 'vitest';

import { expectNoChange, openJournal, PUBLISHER, scribble } from './journal.test-fixture.js';
import { SessionJournal } from './session-journal.js';
import { JournalFencedError, JournalInvalidPublicationError } from './types.js';

const snapshot = (status: AgentSnapshotPayload['status']): AgentSnapshotPayload => ({
  id: 'session-1', providerId: 'codex', createdAt: '2026-11-15T00:00:00.000Z', updatedAt: '2026-11-15T00:00:01.000Z', status, activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: true, cancel: true, readResource: true, interactions: { question: true, planApproval: true, toolApproval: true } },
  pendingInteractions: [], runtimeInfo: { providerId: 'codex', sessionId: 'session-1', status },
});

describe('journal head', () => {
  it('stores the latest snapshot with its observation time and reports it as a change', () => {
    const { journal, publish } = openJournal();
    expect(journal.head).toBeUndefined();
    journal.takeChanges();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    expect(journal.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
    expect(journal.takeChanges()?.meta.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
    journal.setHead(publish(), { snapshot: snapshot('idle'), observedAt: 9 });
    expect(journal.head?.observedAt).toBe(9);
  });

  it('ignores a publication it already applied', () => {
    const { journal, publish } = openJournal();
    const publication = publish();
    journal.setHead(publication, { snapshot: snapshot('running'), observedAt: 5 });
    journal.setHead(publication, { snapshot: snapshot('idle'), observedAt: 9 });
    expect(journal.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
  });

  it('fences off an older connection of the publisher', () => {
    const { journal, publish } = openJournal();
    const stale = publish();
    journal.claim(PUBLISHER);
    expect(() => journal.setHead(stale, { snapshot: snapshot('idle'), observedAt: 1 })).toThrow(JournalFencedError);
    expect(journal.head).toBeUndefined();
  });

  it('survives a store round trip and does not alias the stored value', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    const restored = new SessionJournal(journal.state());
    expect(restored.head).toEqual(journal.head);
    const copy = journal.head!;
    copy.observedAt = 99;
    expect(journal.head?.observedAt).toBe(5);
  });

  it('exposes the publisher with its generation and watermark', () => {
    const { journal, publish } = openJournal();
    expect(journal.publisher).toEqual({ publisherId: PUBLISHER, generation: 1, watermark: 0 });
    journal.setHead(publish(), { snapshot: snapshot('idle'), observedAt: 1 });
    expect(journal.publisher).toEqual({ publisherId: PUBLISHER, generation: 1, watermark: 1 });
    expect(SessionJournal.create('host-1:codex:other').publisher).toBeNull();
  });

  it('changes nothing when the publication is refused', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    const stale = publish();
    journal.claim(PUBLISHER);
    expectNoChange(journal, () => journal.setHead(stale, { snapshot: snapshot('idle'), observedAt: 9 }), JournalFencedError);
    const invalid = { publisherId: PUBLISHER, generation: 2, sequence: 0 };
    expectNoChange(journal, () => journal.setHead(invalid, { snapshot: snapshot('idle'), observedAt: 9 }), JournalInvalidPublicationError);
    expect(journal.head?.observedAt).toBe(5);
  });

  it('does not keep the caller\'s head or hand out its own', () => {
    const { journal, publish } = openJournal();
    const head = { snapshot: snapshot('running'), observedAt: 5 };
    journal.setHead(publish(), head);
    scribble(head);
    scribble(journal.head);
    scribble(journal.publisher);
    scribble(journal.takeChanges());
    expect(journal.head).toEqual({ snapshot: snapshot('running'), observedAt: 5 });
    expect(journal.publisher).toEqual({ publisherId: PUBLISHER, generation: 1, watermark: 1 });
  });

  it('leaves the head and the watermark alone when the head cannot be copied', () => {
    const { journal, publish } = openJournal();
    journal.setHead(publish(), { snapshot: snapshot('running'), observedAt: 5 });
    const uncopyable = { snapshot: snapshot('idle'), observedAt: 9, extra: () => 0 } as never;
    expectNoChange(journal, () => journal.setHead(publish(), uncopyable), Error);
    expect(journal.publisher?.watermark).toBe(1);
  });
});
