import type { ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';

/** An icon-only button; its label is its accessible name and tooltip. */
export function IconButton({ icon, label, className, type = 'button', title, ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & { icon: IconName; label: string }) {
  return <button {...props} type={type} className={className ? `ui-icon-button ${className}` : 'ui-icon-button'} aria-label={label} title={title ?? label}>
    <Icon name={icon} />
  </button>;
}
