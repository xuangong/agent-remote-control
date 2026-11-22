import type { ReactNode } from 'react';
import { Card } from '@orchardworks/agent-client-web/primitives';
import './settings-row.css';

/** A titled set of settings on one card, as the mockup groups them. */
export function SettingsSection({ title, children }: { title?: string; children: ReactNode }) {
  return <section className="lab-setting-section" aria-label={title}>
    {title ? <h3 className="lab-setting-section-title">{title}</h3> : null}
    <Card className="lab-setting-card">{children}</Card>
  </section>;
}

/** One setting: its name and a line of help on the left, its control on the right. */
export function SettingsRow({ label, hint, children, id }: { label: string; hint?: string; children?: ReactNode; id?: string }) {
  return <div className="lab-setting-row" {...(id ? { id } : {})}>
    <div className="lab-setting-text"><strong>{label}</strong>{hint ? <small>{hint}</small> : null}</div>
    {children ? <div className="lab-setting-control">{children}</div> : null}
  </div>;
}
