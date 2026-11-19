import { useId } from 'react';
import { markDrawing } from '../theme/mark.js';
import { markMotion } from '../theme/motion.js';
import { useMotionState } from './MotionProvider.js';

/** The Orchard mark in brand tokens. Above 32 px, and while motion is allowed, its eyes glance and its sprout sways. */
export function OrchardMark({ size, title, className }: { size: number; title?: string; className?: string }) {
  const clip = useId();
  const { glance, sway } = markMotion({ ...useMotionState(), size });
  const { tileRadius, tilt, stem, stemWidth, leaf, body, eyes } = markDrawing;
  return <svg className={className ? `orchard-mark ${className}` : 'orchard-mark'} viewBox="0 0 64 64" width={size} height={size} focusable="false"
    {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
    {title ? <title>{title}</title> : null}
    <defs><clipPath id={clip}><rect width="64" height="64" rx={tileRadius} /></clipPath></defs>
    <g clipPath={`url(#${clip})`}>
      <rect className="orchard-mark-tile" width="64" height="64" />
      <g transform={tilt}>
        <g {...(sway ? { className: 'orchard-mark-sway' } : {})}>
          <path className="orchard-mark-stem" d={stem} strokeWidth={stemWidth} strokeLinecap="round" fill="none" />
          <path className="orchard-mark-leaf" d={leaf} />
        </g>
        <path className="orchard-mark-body" d={body} />
        <g {...(glance ? { className: 'orchard-mark-glance' } : {})}>
          {eyes.map(eye => <ellipse key={eye.cx} className="orchard-mark-eye" cx={eye.cx} cy={eye.cy} rx={eye.rx} ry={eye.ry} />)}
        </g>
      </g>
    </g>
  </svg>;
}
