import { forwardRef, type ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';
export type ButtonSize = 'regular' | 'small';

/** A button that never submits a form unless asked: primary for the main action, secondary by default, plain for text-like actions. */
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }>(
  function Button({ variant = 'secondary', size = 'regular', className, type = 'button', ...props }, ref) {
    return <button {...props} ref={ref} type={type} className={className ? `ui-button ${className}` : 'ui-button'} data-variant={variant} data-size={size} />;
  });
