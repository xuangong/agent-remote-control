/** Shared presentation for the controller entry and standalone authentication callback. */
export const signInReturnKey = 'agent-remote-sign-in-return';
export const accessBrandMark = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 9h18M9 9v12"/></svg>';
export const accessCopy = {
  checking: { title: 'Opening your session', description: 'Checking whether you are already signed in.', status: 'Checking access…' },
  signin: { title: 'Sign in to continue', description: 'Continue through your gateway. We will bring you straight back to this session.', status: '' },
  restoring: { title: 'Reconnecting securely', description: 'Your conversation will return as soon as access is restored.', status: 'Restoring access…' },
  verifying: { title: 'Completing sign-in', description: 'Confirming your access before opening your conversation.', status: 'Verifying access…' },
  opening: { title: 'You are signed in', description: 'Taking you back to your conversation.', status: 'Opening session…' },
  expired: { title: 'Let’s try signing in again', description: 'This sign-in has expired or is no longer valid. Start again in this browser.', status: '' },
  unavailable: { title: 'Connection interrupted', description: 'We could not reach the service. Check your connection and try again.', status: '' },
} as const;
export type AccessPageState = keyof typeof accessCopy;

export const accessPageStyle = `
.arc-access {
  --entry-bg: var(--obs-canvas, oklch(0.975 0.006 255.5));
  --entry-surface: var(--obs-surface, oklch(0.993 0.003 247.9));
  --entry-text: var(--obs-text, oklch(0.243 0.024 248.8));
  --entry-muted: var(--obs-text-secondary, oklch(0.485 0.029 246.6));
  --entry-line: var(--obs-border, oklch(0.909 0.016 248));
  --entry-action: var(--obs-action, oklch(0.533 0.137 250.7));
  box-sizing: border-box; min-height: 100svh; width: 100%; margin: 0;
  display: grid; grid-template-rows: auto 1fr auto;
  padding: max(28px, env(safe-area-inset-top)) max(32px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
  background: var(--entry-bg); color: var(--entry-text);
  font: 400 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
.arc-access *, .arc-access *::before, .arc-access *::after { box-sizing: border-box; }
.arc-access [hidden] { display: none !important; }
.arc-access-brand { display: flex; align-items: center; gap: 10px; width: min(100%, 1040px); margin-inline: auto; font-weight: 650; letter-spacing: -.02em; }
.arc-access-brand svg { width: 26px; height: 26px; color: var(--entry-action); }
.arc-access-body { width: min(100%, 424px); margin: auto; padding-block: 56px 72px; }
.arc-access-progress { display: flex; list-style: none; padding: 0; margin: 0 0 44px; gap: 16px; }
.arc-access-progress li { flex: 1; border-top: 2px solid var(--entry-line); padding-top: 10px; color: var(--entry-muted); font-size: 12px; }
.arc-access-progress li[aria-current="step"] { color: var(--entry-action); border-color: var(--entry-action); font-weight: 650; }
.arc-access-progress span { margin-right: 7px; font-variant-numeric: tabular-nums; }
.arc-access-eyebrow { color: var(--entry-muted); margin: 0 0 12px; font-size: 11px; font-weight: 650; letter-spacing: .12em; text-transform: uppercase; }
.arc-access h1 { font-size: 30px; line-height: 1.2; font-weight: 650; letter-spacing: -.035em; margin: 0 0 16px; text-wrap: balance; }
.arc-access h1:focus { outline: none; }
.arc-access-description { color: var(--entry-muted); font-size: 16px; margin: 0; line-height: 1.65; max-width: 40ch; }
.arc-access-activity { display: flex; align-items: center; gap: 10px; margin-top: 32px; color: var(--entry-muted); font-size: 13px; }
.arc-access-activity::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--entry-action); animation: arc-access-pulse 1.6s ease-in-out infinite; }
.arc-access-actions { display: grid; gap: 12px; margin-top: 32px; }
.arc-access-action { display: flex; align-items: center; justify-content: center; gap: 12px; width: 100%; min-height: 48px; border: 1px solid var(--entry-action); border-radius: 8px; padding: 12px 18px; background: var(--entry-action); color: var(--entry-surface); font: inherit; font-weight: 600; cursor: pointer; text-decoration: none; transition: background-color 180ms ease-out; }
.arc-access .arc-access-action:hover { background: color-mix(in oklch, var(--entry-action) 88%, var(--entry-text)); color: var(--entry-surface); }
.arc-access-action:focus-visible, .arc-access-secondary:focus-visible { outline: 2px solid var(--entry-action); outline-offset: 4px; }
.arc-access .arc-access-secondary { display: flex; justify-content: center; align-items: center; min-height: 44px; padding: 8px; color: var(--entry-muted); background: transparent; border: 0; font: inherit; text-decoration: underline; text-underline-offset: 4px; cursor: pointer; }
.arc-access-note { color: var(--entry-muted); font-size: 12px; line-height: 1.6; margin: 18px 0 0; }
.arc-access-footer { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; width: min(100%, 1040px); margin-inline: auto; padding-top: 18px; border-top: 1px solid var(--entry-line); color: var(--entry-muted); font-size: 12px; }
.arc-access-host { overflow-wrap: anywhere; }
.arc-access[data-state="expired"] .arc-access-eyebrow, .arc-access[data-state="unavailable"] .arc-access-eyebrow { color: var(--obs-warning, oklch(0.532 0.113 62)); }
@keyframes arc-access-pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .arc-access-activity::before { animation: none; } .arc-access-action { transition: none; } }
@media (max-width: 600px) {
  .arc-access { padding-inline: max(24px, env(safe-area-inset-left)) max(24px, env(safe-area-inset-right)); }
  .arc-access-body { padding-block: 48px 64px; }
  .arc-access-progress { margin-bottom: 36px; gap: 12px; }
  .arc-access h1 { font-size: 28px; }
}
@media (max-height: 540px) { .arc-access-body { padding-block: 24px 32px; } .arc-access-progress { margin-bottom: 24px; } }
`;
