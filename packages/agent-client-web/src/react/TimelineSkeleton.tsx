import { createContext, useContext } from 'react';

/**
 * The newest reply of the conversation as its list row has it, for a conversation whose timeline has not arrived: the skeleton shows it as
 * its last bubble, so the person reads the assistant's last words while the rest loads.
 */
export const OpeningReplyContext = createContext<string | undefined>(undefined);

/**
 * The shape of a conversation whose timeline has not arrived: a few bubbles of plain blocks, no words, at the height the first rows will take,
 * so a conversation this device has not seen opens with its layout in place instead of a blank body. The last bubble carries the newest
 * reply when the list knows it.
 */
export function TimelineSkeleton() {
  const reply = useContext(OpeningReplyContext);
  const sides = ['theirs', 'mine', 'theirs', 'theirs'] as const;
  return <div className="agent-timeline-skeleton">
    {sides.map((side, index) => index === sides.length - 1 && reply
      ? <p key={index} className="agent-timeline-skeleton-bubble agent-timeline-opening-reply" data-from={side}>{reply}</p>
      : <div key={index} className="agent-timeline-skeleton-bubble" data-from={side} aria-hidden="true" />)}
  </div>;
}
