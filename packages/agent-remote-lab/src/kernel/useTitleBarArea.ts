/**
 * The installed desktop app's title bar area, when its window gives the title bar to the page (Window Controls Overlay): the part of
 * the window's top edge clear of the traffic lights or the window controls. Undefined in a browser tab, in an app window that shows
 * its own title bar, and on platforms without the overlay. It follows the window as the overlay changes (`geometrychange`).
 */
import { useEffect, useState } from 'react';

export interface TitleBarArea { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** What the page reads of the overlay (`navigator.windowControlsOverlay`); not in the DOM types. */
export interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** The area, or undefined when the overlay is absent or hidden. */
export function titleBarArea(overlay: WindowControlsOverlay | undefined): TitleBarArea | undefined {
  if (!overlay?.visible) return undefined;
  const { x, y, width, height } = overlay.getTitlebarAreaRect();
  return height > 0 ? { x, y, width, height } : undefined;
}

const same = (a: TitleBarArea | undefined, b: TitleBarArea | undefined) =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);

export function useTitleBarArea(overlay: WindowControlsOverlay | undefined = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay): TitleBarArea | undefined {
  const [area, setArea] = useState(() => titleBarArea(overlay));
  useEffect(() => {
    if (!overlay) return;
    const update = () => setArea(current => { const next = titleBarArea(overlay); return same(current, next) ? current : next; });
    update();
    overlay.addEventListener('geometrychange', update);
    return () => overlay.removeEventListener('geometrychange', update);
  }, [overlay]);
  return area;
}
