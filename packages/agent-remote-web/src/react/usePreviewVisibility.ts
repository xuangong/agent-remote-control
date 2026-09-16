import { useEffect, useRef, useState, type RefObject } from 'react';

export function usePreviewVisibility(dialog: RefObject<HTMLDialogElement>, visible: boolean, key: string) {
  const shown = useRef(false);
  const [modal, setModal] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  const previousModal = useRef(modal);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => setModal(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    let cancelled = false;
    let animation: Animation | undefined;
    const dock = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-preview-key]')).find(candidate => {
      if (candidate.dataset.previewKey !== key) return false;
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight;
    });
    const minimize = () => {
      const restoreFocus = element.contains(document.activeElement);
      element.close();
      animation?.cancel();
      if (restoreFocus) dock?.focus({ preventScroll: true });
    };
    const changedMode = previousModal.current !== modal;
    previousModal.current = modal;
    if (changedMode && element.open) element.close();
    if (visible) { if (modal) element.showModal(); else element.show(); }
    if (!element.open) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (changedMode || reduced || !element.animate || (visible && !shown.current)) {
      if (!visible) minimize();
      shown.current = true;
      return;
    }
    const from = element.getBoundingClientRect();
    const to = dock?.getBoundingClientRect();
    const left = to?.left ?? window.innerWidth - 48;
    const top = to?.top ?? 64;
    const small = `translate(${left - from.left}px, ${top - from.top}px) scale(${(to?.width ?? 36) / from.width}, ${(to?.height ?? 32) / from.height})`;
    const expanded = { transform: 'translate(0, 0) scale(1)', opacity: 1 };
    const collapsed = { transform: small, opacity: 0.15 };
    element.dataset.motion = visible ? 'restoring' : 'minimizing';
    animation = element.animate(visible ? [collapsed, expanded] : [expanded, collapsed], {
      duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards',
    });
    void animation.finished.then(() => {
      if (cancelled) return;
      if (!visible) minimize();
      else animation?.cancel();
      delete element.dataset.motion;
    }).catch(() => {});
    shown.current = true;
    return () => { cancelled = true; animation?.cancel(); delete element.dataset.motion; };
  }, [dialog, visible, key, modal]);
}
