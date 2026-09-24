import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender, unmount } from '../test/setup.js';
import { useNearViewport } from './useNearViewport.js';

afterEach(() => vi.unstubAllGlobals());

function Image({ identity }: { identity: string }) {
  const { ref, near } = useNearViewport(identity);
  return <span key={identity} ref={ref} data-ready={near}>{identity}</span>;
}

function observers() {
  const instances: Array<{ callback: IntersectionObserverCallback; observe: ReturnType<typeof vi.fn>;
    unobserve: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn>; options?: IntersectionObserverInit }> = [];
  vi.stubGlobal('IntersectionObserver', class {
    observe = vi.fn(); unobserve = vi.fn(); disconnect = vi.fn();
    constructor(public callback: IntersectionObserverCallback, public options?: IntersectionObserverInit) { instances.push(this); }
  });
  return instances;
}

it('shares one observer per scrolling region and releases it after all targets leave', async () => {
  const instances = observers();
  const container = await render(<div style={{ overflowY: 'auto' }}><Image identity="one" /><Image identity="two" /></div>);
  expect(instances).toHaveLength(1);
  const observer = instances[0]!;
  expect(observer.options?.root).toBe(container.firstElementChild);
  expect(observer.observe).toHaveBeenCalledTimes(2);
  await unmount(container);
  expect(observer.unobserve).toHaveBeenCalledTimes(2);
  expect(observer.disconnect).toHaveBeenCalledOnce();
});

it('activates only intersecting resources and observes a replacement identity again', async () => {
  const instances = observers();
  const container = await render(<Image identity="one" />);
  const element = container.querySelector('span')!;
  expect(element.dataset.ready).toBe('false');
  await act(async () => instances[0]!.callback([{ target: element, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(element.dataset.ready).toBe('false');
  await act(async () => instances[0]!.callback([{ target: element, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(element.dataset.ready).toBe('true');
  expect(instances[0]!.disconnect).toHaveBeenCalledOnce();
  await rerender(container, <Image identity="two" />);
  expect(container.querySelector('span')!.dataset.ready).toBe('false');
  expect(instances).toHaveLength(2);
  await unmount(container);
});

it('loads without IntersectionObserver support', async () => {
  vi.stubGlobal('IntersectionObserver', undefined);
  const container = await render(<Image identity="one" />);
  expect(container.querySelector('span')!.dataset.ready).toBe('true');
});
