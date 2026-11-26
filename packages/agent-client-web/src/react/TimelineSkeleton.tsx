/**
 * The shape of a conversation whose timeline has not arrived: a few bubbles of plain blocks, no words, at the height the first rows will take,
 * so a conversation this device has not seen opens with its layout in place instead of a blank body.
 */
export function TimelineSkeleton() {
  return <div className="agent-timeline-skeleton" aria-hidden="true">
    {(['theirs', 'mine', 'theirs', 'theirs'] as const).map((side, index) => <div key={index} className="agent-timeline-skeleton-bubble" data-from={side} />)}
  </div>;
}
