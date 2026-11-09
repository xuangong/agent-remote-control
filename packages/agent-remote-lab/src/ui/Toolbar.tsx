import type { ReactNode } from 'react';

/** The 52px bar above content: the current object (picture, title heading, subtitle) and its actions. Place it inside the app's main region (outside it a header becomes a banner landmark); `title` is phrasing content, such as text or inline elements. */
export function Toolbar({ leading, title, subtitle, trailing }: { leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode }) {
  return <header className="ui-toolbar">
    {leading ? <span className="ui-toolbar-leading">{leading}</span> : null}
    <div className="ui-toolbar-heading">
      <h2 className="ui-toolbar-title">{title}</h2>
      {subtitle ? <div className="ui-toolbar-subtitle">{subtitle}</div> : null}
    </div>
    {trailing ? <div className="ui-toolbar-trailing">{trailing}</div> : null}
  </header>;
}
