import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach } from 'vitest';

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
});

export async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(node));
  return container;
}

export async function unmount(container: HTMLDivElement): Promise<void> {
  const index = mounted.findIndex((entry) => entry.container === container);
  const entry = index === -1 ? undefined : mounted.splice(index, 1)[0];
  if (!entry) return;
  await act(async () => entry.root.unmount());
  entry.container.remove();
}

export async function rerender(container: HTMLDivElement, node: ReactNode): Promise<void> {
  const entry = mounted.find((candidate) => candidate.container === container);
  if (!entry) throw new Error('The requested container is not mounted.');
  await act(async () => entry.root.render(node));
}
