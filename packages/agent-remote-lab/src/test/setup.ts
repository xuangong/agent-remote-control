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
  if (typeof window !== 'undefined') window.history.replaceState(null, '', '/');
});

export async function render(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(node));
  return container;
}
