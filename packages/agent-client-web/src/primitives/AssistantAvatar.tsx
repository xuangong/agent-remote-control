import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BotPicture } from '@orchardworks/agent-remote-protocol';
import { avatarEye, avatarEyes, avatarShapes, avatarWith, type AvatarMood } from '../theme/avatar.js';
import { avatarMotion } from '../theme/motion.js';
import { orchardMotion } from '../theme/tokens.js';
import { useMotionState } from './MotionProvider.js';

/**
 * An assistant's avatar: its shape and colour with two eyes, from its id or its stored picture. The outline flows
 * (SMIL, since Safari cannot animate CSS `d`) while the motion rule allows; when it does not, no `<animate>` exists.
 * Bob, pop and grey are CSS on the root. Decorative unless a `label` names it.
 */
export function AssistantAvatar({ id, picture, size, mood = 'idle', label, className }: {
  id: string; picture?: BotPicture; size: number; mood?: AvatarMood; label?: string; className?: string;
}) {
  const recipe = avatarWith(id, picture);
  const motion = avatarMotion({ ...useMotionState(), size, mood });
  const shape = avatarShapes[recipe.shape];
  const eyes = avatarEyes(recipe.shape, recipe.gaze);
  // The pop plays once each time the mood becomes needs_you; a render with the same mood keeps the same attribute.
  const [pops, setPops] = useState(0);
  const previous = useRef<AvatarMood | undefined>(undefined);
  useEffect(() => {
    if (mood === 'needs_you' && previous.current !== 'needs_you') setPops(count => count + 1);
    previous.current = mood;
  }, [mood]);
  const [first, second, third] = shape.keyframes;
  return <span className={className ? `orchard-avatar orchard-avatar ${className}` : 'orchard-avatar orchard-avatar'}
    data-shape={recipe.shape} data-mood={mood} {...(motion.bob ? { 'data-bob': '' } : {})} {...(motion.pop && pops > 0 ? { 'data-pop': String(pops) } : {})}
    style={{ '--orchard-avatar-size': `${size}px` } as CSSProperties}
    {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
    <svg viewBox="0 0 64 64" width={size} height={size} focusable="false" aria-hidden="true">
      <path className="orchard-avatar-body" d={shape.base} style={{ fill: motion.grey ? 'var(--orchard-avatar-resting)' : recipe.color }}>
        {motion.outline ? <animate attributeName="d" dur={`${recipe.outlineSeconds}s`} begin={`${-(recipe.phase * recipe.outlineSeconds).toFixed(3)}s`}
          repeatCount="indefinite" calcMode="spline" keyTimes="0;0.333;0.667;1"
          keySplines={[1, 2, 3].map(() => orchardMotion.flowSpline).join(';')} values={[first, second, third, first].join(';')} /> : null}
      </path>
      {eyes.map(([cx, cy], index) => <ellipse key={index} className="orchard-avatar-eye" cx={cx} cy={cy} rx={avatarEye.rx} ry={avatarEye.ry} />)}
    </svg>
  </span>;
}
