import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';
import { clearConversationRecovery } from '../conversation-recovery.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (!entry) continue;
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  if (typeof window !== 'undefined') {
    window.history.replaceState(null, '', '/');
    clearConversationRecovery();
  }
});

export function setPromptText(input: HTMLElement, text: string): void {
  if (input instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
  else {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    input.textContent = text;
  }
}
export function promptText(input: HTMLElement): string { return input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? ''; }

export async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(node));
  return container;
}

export async function unmount(container: HTMLDivElement): Promise<void> {
  const index = mounted.findIndex(entry => entry.container === container);
  if (index < 0) throw new Error('The test container is not mounted.');
  const [entry] = mounted.splice(index, 1);
  await act(async () => entry!.root.unmount());
  container.remove();
}
