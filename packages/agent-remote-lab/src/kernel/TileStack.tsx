import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';

/**
 * A window on a phone (I3 plan, decision 14): its tiles side by side, one per screen, swiped through with scroll snapping,
 * and a page indicator in its own row below them, so nothing floats over a conversation. The presented tile is the
 * window's route: a swipe that settles on another tile presents it, and presenting one elsewhere scrolls to it.
 */
export function TileStack({ tiles, selectedId, onSelect }: {
  tiles: readonly { id: string; title: string; node: ReactNode }[]; selectedId?: string; onSelect(id: string): void;
}) {
  const t = useTranslate();
  const track = useRef<HTMLDivElement>(null);
  const latest = useRef({ tiles, selectedId, onSelect }); latest.current = { tiles, selectedId, onSelect };
  const index = Math.max(0, tiles.findIndex(tile => tile.id === selectedId));
  useLayoutEffect(() => {
    const element = track.current;
    if (element && Math.round(element.scrollLeft / Math.max(1, element.clientWidth)) !== index) element.scrollTo({ left: index * element.clientWidth });
  }, [index, tiles.length]);
  // Presents the tile a swipe settled on; scrolling stops on a snap point, after which no scroll event follows for a moment.
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      const { tiles, selectedId, onSelect } = latest.current;
      const tile = tiles[Math.round(element.scrollLeft / Math.max(1, element.clientWidth))];
      if (tile && tile.id !== selectedId) onSelect(tile.id);
    };
    const scrolled = () => { clearTimeout(timer); timer = setTimeout(settle, 120); };
    element.addEventListener('scroll', scrolled, { passive: true });
    return () => { clearTimeout(timer); element.removeEventListener('scroll', scrolled); };
  }, []);
  return <div className="lab-tile-stack">
    <div ref={track} className="lab-tile-stack-track">{tiles.map(tile => <div key={tile.id} className="lab-tile-stack-page" data-tile-id={tile.id}>{tile.node}</div>)}</div>
    {tiles.length > 1 ? <nav className="lab-tile-stack-pages" aria-label={t('tiles.pages')}>
      {tiles.map((tile, position) => <button key={tile.id} type="button" aria-label={t('tiles.page', { position: position + 1, count: tiles.length, title: tile.title })}
        aria-current={position === index || undefined} onClick={() => onSelect(tile.id)}><span aria-hidden="true" /></button>)}
    </nav> : null}
  </div>;
}
