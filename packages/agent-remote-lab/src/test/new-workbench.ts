import { act } from 'react';

/** jsdom has no modal dialogs: a sheet opens by being marked open. Call once at the top of a test file that opens the new-workbench choice. */
export function stubDialogs(): void {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
}

/** Answers the new-workbench choice with a free workbench, as the person did before bot workbenches existed. */
export async function chooseFreeWorkbench(): Promise<void> {
  const free = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Free workbench');
  if (!free) throw new Error('The new-workbench choice is not open.');
  await act(async () => free.click());
}
