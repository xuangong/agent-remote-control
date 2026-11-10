import { forwardRef, useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * A sidebar or list row: optional picture, a title with an optional subtitle, and an optional trailing accessory.
 * The accessible name is the title; the subtitle and trailing accessory are its description.
 * `leading` and `trailing` must not contain interactive elements: the whole row is one button,
 * so put row actions next to the row, never inside it.
 */
export const ListRow = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
  leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; selected?: boolean;
}>(function ListRow({ leading, title, subtitle, trailing, selected, className, type = 'button', ...props }, ref) {
  const id = useId();
  const describedBy = [subtitle ? `${id}-subtitle` : null, trailing ? `${id}-trailing` : null].filter(Boolean).join(' ');
  return <button aria-labelledby={`${id}-title`} aria-describedby={describedBy || undefined} {...props} ref={ref} type={type}
    className={className ? `ui-list-row ${className}` : 'ui-list-row'} aria-current={selected || undefined}>
    {leading ? <span className="ui-list-row-leading">{leading}</span> : null}
    <span className="ui-list-row-text">
      <span id={`${id}-title`} className="ui-list-row-title">{title}</span>
      {subtitle ? <span id={`${id}-subtitle`} className="ui-list-row-subtitle">{subtitle}</span> : null}
    </span>
    {trailing ? <span id={`${id}-trailing`} className="ui-list-row-trailing">{trailing}</span> : null}
  </button>;
});
