import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon.js';

/** An icon-only button; its label is its accessible name and tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> & { icon: IconName; label: string }>(
  function IconButton({ icon, label, className, type = 'button', title, ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={className ? `ui-icon-button ${className}` : 'ui-icon-button'} aria-label={label} title={title ?? label}>
      <Icon name={icon} />
    </button>;
  });
