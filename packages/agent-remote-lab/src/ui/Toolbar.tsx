import type { ReactNode, Ref } from 'react';

/** The 52px bar above content: the current object (picture, title heading, subtitle) and its actions. Place it inside the app's main region (outside it a header becomes a banner landmark); `title` is phrasing content, such as text or inline elements. A `titleFocusable` heading can take focus from script (tabIndex -1), for owners that move focus to it. */
export function Toolbar({ leading, title, subtitle, trailing, className, titleRef, titleFocusable }: {
  leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; className?: string;
  titleRef?: Ref<HTMLHeadingElement>; titleFocusable?: boolean;
}) {
  return <header className={className ? `ui-toolbar ${className}` : 'ui-toolbar'}>
    {leading ? <span className="ui-toolbar-leading">{leading}</span> : null}
    <div className="ui-toolbar-heading">
      <h2 ref={titleRef} className="ui-toolbar-title" tabIndex={titleFocusable ? -1 : undefined}>{title}</h2>
      {subtitle ? <div className="ui-toolbar-subtitle">{subtitle}</div> : null}
    </div>
    {trailing ? <div className="ui-toolbar-trailing">{trailing}</div> : null}
  </header>;
}
