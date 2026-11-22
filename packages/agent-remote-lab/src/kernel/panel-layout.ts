/**
 * The desktop panels' widths: the rail, Bot mode's assistant list (the sidebar), the conversation and the details. Each panel has a
 * minimum and a maximum; the reader's widths are kept per device. The conversation fills what the others leave and keeps its minimum:
 * as a window narrows the details collapse first, then the sidebar and the rail give way down to their minimums, and below the phone
 * width the phone layout takes over. Pure: the viewport, the stored widths and Window mode's own panels come in as data.
 */
import { orchardSpace } from '@orchardworks/agent-client-web/theme';

export type ResizablePanel = 'rail' | 'sidebar' | 'details';
export interface PanelBounds { readonly min: number; readonly max: number; readonly default: number }

/** Pixels. The rail shows labels beside its icons once it is wide enough (shell.css). */
export const PANEL_BOUNDS: Readonly<Record<ResizablePanel, PanelBounds>> = {
  rail: { min: 60, max: 200, default: 60 },
  sidebar: { min: 220, max: 420, default: 260 },
  details: { min: 260, max: 480, default: 300 },
};
/** The conversation's minimum: at the default widths the details sit beside it from 1181 px, and collapse at 1180 px and below. */
export const CONVERSATION_MIN = 511;

/** The gap between floating panels, the rail's outer margin and the workspace's padding are one length. */
const GAP = orchardSpace.l;
/** Bot mode: the rail's margin, the workspace's padding on both sides and the gap after the sidebar. A shown details panel adds one gap. */
const BOT_CHROME = 4 * GAP;
/** Window mode: the rail's margin and the shell's padding. */
const WINDOW_CHROME = 2 * GAP;

export type PanelWidths = Readonly<Record<ResizablePanel, number>>;
export const DEFAULT_PANEL_WIDTHS: PanelWidths = { rail: PANEL_BOUNDS.rail.default, sidebar: PANEL_BOUNDS.sidebar.default, details: PANEL_BOUNDS.details.default };

/** Where the frame is: Bot mode's three panels, Window mode (whose sidebar and inspector it does not size), or the phone. */
export type PanelRoom =
  | { readonly mode: 'bot'; readonly viewport: number }
  | { readonly mode: 'window'; readonly viewport: number; /** Window mode's own panels beside its stage: the sidebar and an open inspector. */ readonly beside: number }
  | { readonly mode: 'phone' };

export interface PanelLayout {
  /** The widths shown; on the phone they are the stored ones, unused. */
  readonly widths: PanelWidths;
  /** The details sit beside the conversation by default: they fit with the conversation at its minimum. */
  readonly detailsBeside: boolean;
  /**
   * What each handle may reach now: its own bounds, narrowed so the conversation keeps its minimum. The rail and the list reserve no
   * room for the details: widened past it, they collapse the details, and narrowed again, they bring them back, so no handle is held.
   */
  readonly limits: Readonly<Record<ResizablePanel, { readonly min: number; readonly max: number }>>;
  /** Which panels have a handle. */
  readonly handles: readonly ResizablePanel[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const bounded = (panel: ResizablePanel, value: number) => clamp(Math.round(value), PANEL_BOUNDS[panel].min, PANEL_BOUNDS[panel].max);
/** A handle's limit: its own bounds, narrowed by the room, never below the width it shows (a squeezed panel can only grow back). */
const limit = (panel: ResizablePanel, shown: number, room: number) =>
  ({ min: PANEL_BOUNDS[panel].min, max: Math.max(shown, Math.min(PANEL_BOUNDS[panel].max, Math.floor(room))) });

/** The widths the panels take in `room`, given the reader's widths. */
export function layoutPanels(preferred: PanelWidths, room: PanelRoom): PanelLayout {
  const wanted = { rail: bounded('rail', preferred.rail), sidebar: bounded('sidebar', preferred.sidebar), details: bounded('details', preferred.details) };
  if (room.mode === 'phone') return { widths: wanted, detailsBeside: false, limits: fixedLimits(wanted), handles: [] };
  if (room.mode === 'window') {
    // The rail is the frame's only panel in Window mode; it leaves Window mode's stage the conversation's minimum.
    const space = room.viewport - WINDOW_CHROME - room.beside - CONVERSATION_MIN;
    const rail = Math.max(PANEL_BOUNDS.rail.min, Math.min(wanted.rail, space));
    return { widths: { ...wanted, rail }, detailsBeside: false, limits: { ...fixedLimits(wanted), rail: limit('rail', rail, space) }, handles: ['rail'] };
  }
  // Bot mode: what the rail and the sidebar may take with the conversation at its minimum and no details beside it.
  const space = room.viewport - BOT_CHROME - CONVERSATION_MIN;
  let { rail, sidebar } = wanted;
  if (rail + sidebar > space) sidebar = Math.max(PANEL_BOUNDS.sidebar.min, space - rail);
  if (rail + sidebar > space) rail = Math.max(PANEL_BOUNDS.rail.min, space - sidebar);
  const detailsBeside = rail + sidebar + GAP + wanted.details <= space;
  // Details opened where they do not fit take what the conversation leaves above its minimum, and no less than their own.
  const details = detailsBeside ? wanted.details : clamp(space - GAP - rail - sidebar, PANEL_BOUNDS.details.min, wanted.details);
  return {
    widths: { rail, sidebar, details },
    detailsBeside,
    limits: {
      rail: limit('rail', rail, space - sidebar),
      sidebar: limit('sidebar', sidebar, space - rail),
      details: limit('details', details, detailsBeside ? space - GAP - rail - sidebar : details),
    },
    handles: ['rail', 'sidebar', 'details'],
  };
}

function fixedLimits(widths: PanelWidths): PanelLayout['limits'] {
  return { rail: limit('rail', widths.rail, widths.rail), sidebar: limit('sidebar', widths.sidebar, widths.sidebar), details: limit('details', widths.details, widths.details) };
}

/** The localStorage key of the reader's widths on this device; a display choice, so clearing conversations keeps it. */
export const PANEL_WIDTHS_STORAGE_KEY = 'agent-remote:panel-widths';

/** Stored widths, each clamped to its bounds; a missing or unreadable one is its default. */
export function readPanelWidths(stored: string | null): PanelWidths {
  let value: unknown;
  try { value = stored ? JSON.parse(stored) : undefined; } catch { value = undefined; }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const read = (panel: ResizablePanel) => typeof record[panel] === 'number' && Number.isFinite(record[panel]) ? bounded(panel, record[panel] as number) : PANEL_BOUNDS[panel].default;
  return { rail: read('rail'), sidebar: read('sidebar'), details: read('details') };
}

/** The reader's widths after one panel is set to `width` (clamped to its bounds and the handle's limit), or reset with `undefined`. */
export function withPanelWidth(widths: PanelWidths, panel: ResizablePanel, width: number | undefined, reach?: { min: number; max: number }): PanelWidths {
  if (width === undefined) return { ...widths, [panel]: PANEL_BOUNDS[panel].default };
  const set = reach ? clamp(Math.round(width), reach.min, reach.max) : Math.round(width);
  return { ...widths, [panel]: bounded(panel, set) };
}

/** Which way a panel grows when its handle moves right: the rail and the sidebar sit left of it, the details right of it. */
export const GROWS_RIGHTWARD: Readonly<Record<ResizablePanel, boolean>> = { rail: true, sidebar: true, details: false };

/**
 * What a handle's key asks for: an arrow moves the handle 10 px (40 px with Shift) within the panel's limits, Home and End go to them,
 * and Enter restores the default as a double-click does. `undefined` for any other key.
 */
export function keyedWidth(key: string, shift: boolean, panel: ResizablePanel, width: number, reach: { min: number; max: number }): number | 'reset' | undefined {
  if (key === 'Enter') return 'reset';
  const step = shift ? 40 : 10;
  const rightward = GROWS_RIGHTWARD[panel] ? step : -step;
  const next = key === 'ArrowRight' ? width + rightward : key === 'ArrowLeft' ? width - rightward : key === 'Home' ? reach.min : key === 'End' ? reach.max : undefined;
  return next === undefined ? undefined : clamp(next, reach.min, reach.max);
}
