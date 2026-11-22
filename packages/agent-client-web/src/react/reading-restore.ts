/**
 * Scroll memory: where a conversation opens again when it is shown, switched back to or loaded after a reload (I5d). Pure; the
 * reading position of each conversation is kept by the page (TimelineReadingPositions) and read here.
 *
 * - The position saved for the conversation wins: at the latest when the reader was following it, otherwise at the row the reader
 *   was on, at the same offset from the top.
 * - With none saved, a view that carries on another view of the same conversation (continuity) keeps that view's following state
 *   and, when that view was reading back, its scroll offset.
 * - With nothing to go on, a conversation opens at its latest message.
 */
import type { TimelineReadingContinuityPosition, TimelineReadingPosition } from './useTimelineScroll.js';

export interface ReadingRestore {
  readonly following: boolean;
  readonly anchor?: NonNullable<TimelineReadingPosition['anchor']>;
  /** A scroll offset taken from the view this one carries on, applied once rows show. */
  readonly scrollTop?: number;
}

export function restoredReading(saved: TimelineReadingPosition | undefined, continuity: TimelineReadingContinuityPosition | undefined): ReadingRestore {
  const following = saved?.following ?? continuity?.following ?? true;
  return {
    following,
    ...(saved?.anchor ? { anchor: saved.anchor } : {}),
    ...(!saved && !following && continuity?.scrollTop !== undefined ? { scrollTop: continuity.scrollTop } : {}),
  };
}
