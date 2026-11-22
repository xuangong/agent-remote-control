import { describe, expect, it } from 'vitest';
import { CONVERSATION_MIN, DEFAULT_PANEL_WIDTHS, keyedWidth, layoutPanels, PANEL_BOUNDS, readPanelWidths, withPanelWidth, type PanelRoom, type PanelWidths } from './panel-layout.js';

const widths = (rail: number, sidebar: number, details: number): PanelWidths => ({ rail, sidebar, details });
const MAX = widths(PANEL_BOUNDS.rail.max, PANEL_BOUNDS.sidebar.max, PANEL_BOUNDS.details.max);
const MIN = widths(PANEL_BOUNDS.rail.min, PANEL_BOUNDS.sidebar.min, PANEL_BOUNDS.details.min);
const bot = (viewport: number): PanelRoom => ({ mode: 'bot', viewport });
/** What the conversation keeps in Bot mode: the viewport less the rail's margin, the workspace's padding and the gaps. */
const conversation = (viewport: number, shown: PanelWidths, beside: boolean) => viewport - 40 - shown.rail - shown.sidebar - (beside ? 10 + shown.details : 0);

describe('Bot mode', () => {
  // [viewport, stored widths, shown widths, details beside]
  it.each([
    ['defaults at 1440', 1440, DEFAULT_PANEL_WIDTHS, widths(60, 260, 300), true],
    ['defaults at 1181, the narrowest with the details beside', 1181, DEFAULT_PANEL_WIDTHS, widths(60, 260, 300), true],
    ['defaults at 1180, where the details collapse', 1180, DEFAULT_PANEL_WIDTHS, widths(60, 260, 299), false],
    ['defaults at 800: the sidebar gives way to its minimum', 800, DEFAULT_PANEL_WIDTHS, widths(60, 220, 260), false],
    ['a wide sidebar at 1440 keeps its width and the details', 1440, widths(60, 420, 300), widths(60, 420, 300), true],
    ['every panel at its maximum at 1440: the details collapse first', 1440, MAX, widths(200, 420, 260), false],
    ['every panel at its maximum at 1920', 1920, MAX, widths(200, 420, 480), true],
    ['every panel at its maximum at 3440', 3440, MAX, widths(200, 420, 480), true],
    ['every panel at its maximum at 1000: the sidebar, then the rail give way', 1000, MAX, widths(200, 249, 260), false],
    ['every panel at its maximum at 800', 800, MAX, widths(60, 220, 260), false],
    ['every panel at its minimum at 800', 800, MIN, widths(60, 220, 260), false],
    ['every panel at its minimum at 1101, the details beside', 1101, MIN, widths(60, 220, 260), true],
    ['every panel at its minimum at 1100: the details collapse', 1100, MIN, widths(60, 220, 260), false],
  ] as const)('%s', (_name, viewport, stored, shown, beside) => {
    const layout = layoutPanels(stored, bot(viewport));
    expect(layout.widths).toEqual(shown);
    expect(layout.detailsBeside).toBe(beside);
    expect(layout.handles).toEqual(['rail', 'sidebar', 'details']);
    // The conversation keeps its minimum wherever the rail and the sidebar can still give way.
    if (viewport - 40 - PANEL_BOUNDS.rail.min - PANEL_BOUNDS.sidebar.min >= CONVERSATION_MIN) expect(conversation(viewport, shown, beside)).toBeGreaterThanOrEqual(CONVERSATION_MIN);
  });

  it('never lets a handle take the conversation under its minimum, and never holds the rail or the list for the details', () => {
    for (const viewport of [800, 1024, 1180, 1181, 1300, 1440, 1920, 2560, 3440]) for (const stored of [MIN, DEFAULT_PANEL_WIDTHS, MAX]) {
      const layout = layoutPanels(stored, bot(viewport));
      const space = viewport - 40 - CONVERSATION_MIN;
      for (const [panel, other] of [['rail', 'sidebar'], ['sidebar', 'rail']] as const) {
        // The limit is the panel's own maximum or what leaves the conversation its minimum without the details, whichever is less.
        expect(layout.limits[panel], `${panel} at ${viewport}`).toEqual({ min: PANEL_BOUNDS[panel].min,
          max: Math.max(layout.widths[panel], Math.min(PANEL_BOUNDS[panel].max, space - layout.widths[other])) });
        const pushed = layoutPanels({ ...layout.widths, [panel]: layout.limits[panel].max }, bot(viewport));
        expect(conversation(viewport, pushed.widths, false), `${panel} at ${viewport}`).toBeGreaterThanOrEqual(Math.min(CONVERSATION_MIN, conversation(viewport, layout.widths, false)));
      }
      // Shown details widen until the conversation keeps its minimum beside them, and stay.
      if (layout.detailsBeside) {
        const pushed = layoutPanels({ ...layout.widths, details: layout.limits.details.max }, bot(viewport));
        expect(pushed.detailsBeside, `details at ${viewport}`).toBe(true);
        expect(conversation(viewport, pushed.widths, true), `details at ${viewport}`).toBeGreaterThanOrEqual(CONVERSATION_MIN);
      }
    }
  });

  it('lets a list narrowed until the details fit widen again, past the point where they collapse', () => {
    // At 1300 px a 400 px list leaves the details no room; at 379 px they fit, and the list can still go back to 400 and on to 420.
    expect(layoutPanels(widths(60, 400, 300), bot(1300)).detailsBeside).toBe(false);
    const narrowed = layoutPanels(widths(60, 379, 300), bot(1300));
    expect(narrowed.detailsBeside).toBe(true);
    expect(narrowed.limits.sidebar.max).toBe(420);
  });

  it('gives each handle the room left by the others at 1440 with the defaults', () => {
    expect(layoutPanels(DEFAULT_PANEL_WIDTHS, bot(1440)).limits).toEqual({
      rail: { min: 60, max: 200 }, sidebar: { min: 220, max: 420 }, details: { min: 260, max: 480 } });
    // At 1300 the list may still reach its maximum: the details collapse once it passes 379.
    expect(layoutPanels(DEFAULT_PANEL_WIDTHS, bot(1300)).limits.sidebar).toEqual({ min: 220, max: 420 });
    // Collapsed details cannot be widened past what they were given.
    expect(layoutPanels(DEFAULT_PANEL_WIDTHS, bot(1180)).limits.details).toEqual({ min: 260, max: 299 });
  });
});

describe('Window mode and the phone', () => {
  it.each([
    ['a wide rail at 1440 beside a 260 px sidebar', 1440, 260, 200, 200, 200],
    ['a wide rail at 1000 beside a 260 px sidebar and an open inspector: it gives way to its minimum', 1000, 580, 200, 60, 60],
    ['a wide rail at 1000 beside a hidden sidebar', 1000, 0, 200, 200, 200],
    ['the default rail at 900 with a sidebar', 900, 260, 60, 60, 109],
  ] as const)('%s', (_name, viewport, beside, stored, shown, max) => {
    const layout = layoutPanels({ ...DEFAULT_PANEL_WIDTHS, rail: stored }, { mode: 'window', viewport, beside });
    expect(layout.widths.rail).toBe(shown);
    expect(layout.limits.rail.max).toBe(max);
    expect(layout.handles).toEqual(['rail']);
    expect(layout.detailsBeside).toBe(false);
  });

  it('has no handle on the phone and keeps the stored widths for the desktop', () => {
    const layout = layoutPanels(widths(120, 300, 400), { mode: 'phone' });
    expect(layout.handles).toEqual([]);
    expect(layout.widths).toEqual(widths(120, 300, 400));
    expect(layout.detailsBeside).toBe(false);
  });
});

describe('the widths kept on this device', () => {
  it.each([
    ['nothing stored', null, DEFAULT_PANEL_WIDTHS],
    ['unreadable JSON', '{rail', DEFAULT_PANEL_WIDTHS],
    ['not an object', '42', DEFAULT_PANEL_WIDTHS],
    ['every width', '{"rail":120,"sidebar":300,"details":400}', widths(120, 300, 400)],
    ['some widths', '{"sidebar":333}', widths(60, 333, 300)],
    ['out of bounds, clamped', '{"rail":10,"sidebar":9000,"details":-5}', widths(60, 420, 260)],
    ['fractions, rounded', '{"rail":99.6,"sidebar":250.2,"details":300.5}', widths(100, 250, 301)],
    ['not numbers', '{"rail":"wide","sidebar":null,"details":true}', DEFAULT_PANEL_WIDTHS],
  ] as const)('reads %s', (_name, stored, expected) => {
    expect(readPanelWidths(stored)).toEqual(expected);
  });

  it('sets one width within its bounds and the handle\'s reach, and resets it to its default', () => {
    expect(withPanelWidth(DEFAULT_PANEL_WIDTHS, 'sidebar', 333.4)).toEqual(widths(60, 333, 300));
    expect(withPanelWidth(DEFAULT_PANEL_WIDTHS, 'sidebar', 900)).toEqual(widths(60, 420, 300));
    expect(withPanelWidth(DEFAULT_PANEL_WIDTHS, 'sidebar', 400, { min: 220, max: 379 })).toEqual(widths(60, 379, 300));
    expect(withPanelWidth(widths(150, 400, 450), 'details', undefined)).toEqual(widths(150, 400, 300));
    expect(readPanelWidths(JSON.stringify(withPanelWidth(DEFAULT_PANEL_WIDTHS, 'rail', 140)))).toEqual(widths(140, 260, 300));
  });
});

describe('the handles\' keys', () => {
  const reach = { min: 220, max: 379 };
  it.each([
    ['ArrowRight widens the sidebar', 'ArrowRight', false, 'sidebar', 260, 270],
    ['ArrowLeft narrows the sidebar', 'ArrowLeft', false, 'sidebar', 260, 250],
    ['Shift moves 40 px', 'ArrowRight', true, 'sidebar', 260, 300],
    ['ArrowLeft widens the details, which sit right of their handle', 'ArrowLeft', false, 'details', 300, 310],
    ['ArrowRight narrows the details', 'ArrowRight', false, 'details', 300, 290],
    ['an arrow stops at the reach', 'ArrowRight', true, 'sidebar', 370, 379],
    ['an arrow stops at the minimum', 'ArrowLeft', true, 'sidebar', 230, 220],
    ['Home goes to the minimum', 'Home', false, 'sidebar', 300, 220],
    ['End goes to the reach', 'End', false, 'sidebar', 300, 379],
    ['Enter restores the default', 'Enter', false, 'sidebar', 300, 'reset'],
    ['another key does nothing', 'a', false, 'sidebar', 300, undefined],
  ] as const)('%s', (_name, key, shift, panel, width, expected) => {
    expect(keyedWidth(key, shift, panel, width, reach)).toBe(expected);
  });
});
