import { useEffect, useRef, useState } from 'react';

interface Observation {
  observer: IntersectionObserver;
  targets: Map<Element, () => void>;
}
const observations = new WeakMap<Element | Document, Observation>();

function scrollContainer(element: Element): Element | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Start once near the reading viewport; retain loaded resources when scrolling away. */
export function useNearViewport(identity: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [activated, setActivated] = useState<string>();
  const near = activated === identity;
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    if (typeof IntersectionObserver === 'undefined') {
      setActivated(identity);
      return;
    }
    const root = scrollContainer(element);
    const key = root ?? element.ownerDocument;
    let observation = observations.get(key);
    if (!observation) {
      const targets = new Map<Element, () => void>();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) targets.get(entry.target)?.();
      }, { root, rootMargin: '1200px 0px' });
      observation = { observer, targets };
      observations.set(key, observation);
    }
    observation.targets.set(element, () => setActivated(identity));
    observation.observer.observe(element);
    return () => {
      observation.targets.delete(element);
      observation.observer.unobserve(element);
      if (!observation.targets.size) {
        observation.observer.disconnect();
        observations.delete(key);
      }
    };
  }, [identity, near]);
  return { ref, near };
}
