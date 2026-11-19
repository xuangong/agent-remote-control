import type { ButtonHTMLAttributes } from 'react';
import { rootClass } from './classes.js';

/** A capsule button: `primary` is the brand fill with dark ink, `plain` the surface. */
export function Pill({ variant = 'plain', className, type = 'button', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'plain' }) {
  return <button {...props} type={type} className={rootClass('orchard-pill', className)} data-variant={variant} />;
}
