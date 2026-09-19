import type { SessionCatchUp } from '../hooks/useSessionCatchUp.js';

export function SessionCatchUpRing({ value }: { value?: SessionCatchUp }) {
  if (!value || value.state === 'unavailable') return null;
  const complete = value.state === 'complete';
  return <span key={value.id} className="lab-tracking-catch-up" data-state={value.state}
    role="progressbar" aria-label={complete ? 'Conversation caught up to the observed activity' : 'Catching up to the observed activity'}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={complete ? 100 : Math.floor(value.progress * 100)}>
    <svg width="100%" height="100%" aria-hidden="true">
      <rect x="0.5" y="0.5" width="calc(100% - 1px)" height="calc(100% - 1px)" rx="23.5" pathLength="100"
        strokeDasharray={complete ? 'none' : '100'} strokeDashoffset={complete ? 0 : 100 - value.progress * 100} />
    </svg>
  </span>;
}
