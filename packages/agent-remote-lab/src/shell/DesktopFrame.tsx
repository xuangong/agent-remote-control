/**
 * The frame: the rail (or the tab bar), the mode's surfaces and the pages, laid side by side, with its desktop chrome. The panels'
 * widths (panel-layout.ts) are CSS lengths on it; its handles resize them in the gaps between the floating panels; the installed app's
 * title bar shows when its window gives the title bar to the page; and it sets the window's title. Shared by Bot mode, Window mode and
 * the pages over them. A moving handle renders the frame alone: its children are the workbench's, unchanged, and the workbench reads
 * only whether Bot mode's details fit (`useDetailsBeside`).
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslate } from '@orchardworks/agent-client-web/react';
import { GROWS_RIGHTWARD, keyedWidth, layoutPanels, withPanelWidth, type ResizablePanel } from '../kernel/panel-layout.js';
import { usePanelWidths, useViewportWidth } from '../kernel/usePanelWidths.js';
import { useTitleBarArea, type TitleBarArea } from '../kernel/useTitleBarArea.js';
import { PRODUCT_NAME, windowTitle } from '../kernel/window-title.js';
import './panels.css';

export { useDetailsBeside } from '../kernel/usePanelWidths.js';

export interface DesktopFrameProps {
  /** What the frame shows beside the rail: Bot mode's panels, Window mode, or a page (Settings, the Assistants directory) over either. */
  readonly surface: 'bot' | 'window' | 'page';
  readonly phone: boolean;
  /** Window mode's own panels beside its stage (its sidebar and an open inspector), which the rail leaves room for. */
  readonly windowBeside?: number;
  /** The name on screen: the window's title and the installed app's title bar carry it. */
  readonly title?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
}

const LABELS: Readonly<Record<ResizablePanel, 'navigation.panels.rail' | 'navigation.panels.sidebar' | 'navigation.panels.details'>> = {
  rail: 'navigation.panels.rail', sidebar: 'navigation.panels.sidebar', details: 'navigation.panels.details',
};

export function DesktopFrame({ surface, phone, windowBeside = 0, title, style, children }: DesktopFrameProps) {
  const store = usePanelWidths();
  const viewport = useViewportWidth();
  const area = useTitleBarArea();
  // Bot mode's panels keep their layout under a page, so its details are where they were when the page closes.
  const bot = layoutPanels(store.widths, phone ? { mode: 'phone' } : { mode: 'bot', viewport });
  const layout = surface === 'bot' || phone ? bot : layoutPanels(store.widths, { mode: 'window', viewport, beside: surface === 'window' ? windowBeside : 0 });
  useEffect(() => { document.title = windowTitle(title); }, [title]);
  useEffect(() => () => { document.title = PRODUCT_NAME; }, []);
  const lengths = {
    ...style, '--lab-panel-rail': `${layout.widths.rail}px`, '--lab-panel-sidebar': `${bot.widths.sidebar}px`, '--lab-panel-details': `${bot.widths.details}px`,
    ...(area ? { '--lab-title-bar-height': `${area.y + area.height}px` } : {}),
  } as CSSProperties;
  return <div className="lab-frame" data-rail={!phone || undefined} data-tab-bar={phone || undefined} style={lengths}>
    {children}
    {layout.handles.map(panel => <PanelHandle key={panel} panel={panel} width={layout.widths[panel]} reach={layout.limits[panel]}
      onResize={width => store.show(withPanelWidth(store.widths, panel, width, layout.limits[panel]))} onKeep={store.keep}
      onReset={() => { store.show(withPanelWidth(store.widths, panel, undefined)); store.keep(); }} />)}
    {area ? <TitleBar area={area} name={title?.trim() || PRODUCT_NAME} /> : null}
  </div>;
}

/**
 * One panel's handle: a vertical separator in the gap beside the panel. A drag moves the panel's edge, a double-click or Enter restores
 * its default, the arrow keys move it 10 px (40 px with Shift), Home and End go to its limits.
 */
export function PanelHandle({ panel, width, reach, onResize, onKeep, onReset }: {
  panel: ResizablePanel; width: number; reach: { min: number; max: number };
  onResize(width: number): void; onKeep(): void; onReset(): void;
}) {
  const t = useTranslate();
  const drag = useRef<{ x: number; width: number }>();
  const [dragging, setDragging] = useState(false);
  const end = () => { if (!drag.current) return; drag.current = undefined; setDragging(false); onKeep(); };
  return <div className="lab-panel-handle" data-panel={panel} role="separator" tabIndex={0} aria-orientation="vertical"
    aria-label={t(LABELS[panel])} aria-valuemin={reach.min} aria-valuemax={reach.max} aria-valuenow={width} aria-valuetext={t('navigation.panels.value', { width })}
    title={t('navigation.panels.hint')} data-resizing={dragging || undefined}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
      drag.current = { x: event.clientX, width }; event.currentTarget.setPointerCapture(event.pointerId); setDragging(true);
    }}
    onPointerMove={event => {
      const start = drag.current;
      if (!start) return;
      const moved = event.clientX - start.x;
      onResize(Math.min(reach.max, Math.max(reach.min, start.width + (GROWS_RIGHTWARD[panel] ? moved : -moved))));
    }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={onReset}
    onKeyDown={event => {
      const next = keyedWidth(event.key, event.shiftKey, panel, width, reach);
      if (next === undefined) return;
      event.preventDefault();
      if (next === 'reset') onReset(); else { onResize(next); onKeep(); }
    }} />;
}

/**
 * The installed app's title bar: the name on screen over a drag region, inside the area the window leaves clear of its controls. It
 * repeats the window's title, so assistive technology reads that once.
 */
export function TitleBar({ area, name }: { area: TitleBarArea; name: string }) {
  return <div className="lab-title-bar" aria-hidden="true" style={{ left: area.x, top: area.y, width: area.width, height: area.height }}>
    <span className="lab-title-bar-name">{name}</span>
  </div>;
}
