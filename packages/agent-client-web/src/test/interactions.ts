import { act } from 'react';

/** Opens "Show what changes" on every approval card: the full decisions, the command and the rules. */
export async function showChanges(container: ParentNode): Promise<void> {
  for (const details of container.querySelectorAll<HTMLDetailsElement>('details.agent-approval-changes:not([open])')) {
    await act(async () => details.querySelector('summary')!.click());
  }
}

/** Opens every one-line receipt of an answered interaction, to read today's receipt detail. */
export async function openReceipts(container: ParentNode): Promise<void> {
  for (const button of container.querySelectorAll<HTMLButtonElement>('.agent-receipt-toggle[aria-expanded="false"]')) {
    await act(async () => button.click());
  }
}
