import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

/** A button that never submits a form unless asked: primary for the main action, secondary by default, plain for text-like actions. */
export function Button({ variant = 'secondary', size = 'regular', className, type = 'button', ...props }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'regular' | 'small' }) {
  return <button {...props} type={type} className={className ? `ui-button ${className}` : 'ui-button'} data-variant={variant} data-size={size} />;
}
