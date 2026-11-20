import { createContext, useContext, type ReactNode } from 'react';
import { TimelineTimeContext } from './TimelineTitle.js';
import { useTranslate } from './locale.js';
import { MotionStill } from '../primitives/MotionProvider.js';

/** The assistant's avatar for the foot of its answers, given once by the timeline so rows stay memoized. */
export const BubbleAvatarContext = createContext<ReactNode>(undefined);

/** The assistant's avatar at an answer's foot; `still` in earlier turns, so a long conversation does not move dozens of avatars. */
export function BubbleAvatar({ still = false }: { still?: boolean }) {
  const avatar = useContext(BubbleAvatarContext);
  if (!avatar) return <span className="agent-bubble-avatar-space" />;
  return still ? <MotionStill>{avatar}</MotionStill> : <>{avatar}</>;
}

/** A message's local time under its bubble: quiet until the entry is hovered or focused, and gone while timestamps are hidden (Alt+T). */
export function BubbleTime({ side }: { side: 'mine' | 'theirs' }) {
  const t = useTranslate();
  const time = useContext(TimelineTimeContext);
  if (!time) return null;
  return <time className="agent-bubble-time" data-side={side} dateTime={time.timestamp} hidden={!time.visible}
    aria-label={t('timeline.time.local', { date: time.date, time: time.time })}>{time.time}</time>;
}
