import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** A sidebar or list row: optional picture, a title with an optional subtitle, and an optional trailing accessory. */
export function ListRow({ leading, title, subtitle, trailing, selected, className, type = 'button', ...props }:
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'children'> & {
    leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; selected?: boolean;
  }) {
  return <button {...props} type={type} className={className ? `ui-list-row ${className}` : 'ui-list-row'} aria-current={selected || undefined}>
    {leading ? <span className="ui-list-row-leading">{leading}</span> : null}
    <span className="ui-list-row-text">
      <span className="ui-list-row-title">{title}</span>
      {subtitle ? <span className="ui-list-row-subtitle">{subtitle}</span> : null}
    </span>
    {trailing ? <span className="ui-list-row-trailing">{trailing}</span> : null}
  </button>;
}
