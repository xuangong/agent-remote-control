import { createContext, useContext, type ReactNode } from 'react';
import { TimelineTimeContext } from './TimelineTitle.js';

/** The assistant's avatar for the foot of its answers, given once by the timeline so rows stay memoized. */
export const BubbleAvatarContext = createContext<ReactNode>(undefined);

export function BubbleAvatar() {
  const avatar = useContext(BubbleAvatarContext);
  return avatar ? <>{avatar}</> : <span className="agent-bubble-avatar-space" />;
}

/** A message's local time under its bubble: quiet until the entry is hovered or focused, and gone while timestamps are hidden (Alt+T). */
export function BubbleTime({ side }: { side: 'mine' | 'theirs' }) {
  const time = useContext(TimelineTimeContext);
  if (!time) return null;
  return <time className="agent-bubble-time" data-side={side} dateTime={time.timestamp} hidden={!time.visible}
    aria-label={`${time.date} ${time.time} (local time)`}>{time.time}</time>;
}
