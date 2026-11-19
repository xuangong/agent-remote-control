import type { ReactNode } from 'react';
import { rootClass } from './classes.js';
import { Pill } from './Pill.js';

/** An inline question with plain choices ("好的 / 先别 / 看看要改什么"), on the brand tint. */
export function ApprovalCard({ prompt, choices, className }: {
  prompt: ReactNode; choices: readonly { label: string; primary?: boolean; onChoose(): void }[]; className?: string;
}) {
  return <div className={rootClass('orchard-approval', className)}>
    <div className="orchard-approval-prompt">{prompt}</div>
    <div className="orchard-approval-choices">
      {choices.map(choice => <Pill key={choice.label} variant={choice.primary ? 'primary' : 'plain'} onClick={() => choice.onChoose()}>{choice.label}</Pill>)}
    </div>
  </div>;
}
