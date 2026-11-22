/**
 * F6 and Shift-F6 move the focus between the panels on screen, in the order they sit, wrapping around: the rail (or a phone's
 * tab bar), then Bot mode's list, conversation and details, Window mode's sidebar, tiles and inspector, or a page's panels.
 *
 * `nextPanelIndex` is the rule, pure. `focusNextPanel` applies it to the document: a panel counts when it is on screen and holds
 * something that takes focus, and the focus lands on the panel's entry, which is its text box when it has one that accepts
 * text (the composer), else its current item (the open chat, the current place), else its first control.
 */

/** The panels F6 visits, as the frame lays them out; the document's order is their order on screen. */
export const FOCUS_PANELS = ['.lab-rail', '.lab-tab-bar', '.lab-context-rail', '.lab-main-stage', '.lab-inspector-rail',
  '.lab-bot-workspace > .orchard-panel', '.lab-page > .orchard-panel'].join(', ');

/** The panel after `current` (-1: the focus is in none), or before it going backwards, wrapping around; none when there is none. */
export function nextPanelIndex(count: number, current: number, backwards: boolean): number | undefined {
  if (count <= 0) return undefined;
  if (current < 0 || current >= count) return backwards ? count - 1 : 0;
  return (current + (backwards ? count - 1 : 1)) % count;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const TEXT_BOX = '[role="textbox"][contenteditable="true"]:not([aria-disabled="true"]), textarea:not([disabled]):not([readonly])';
const CURRENT = '[aria-current]:not([aria-current="false"])';

function shown(element: Element): boolean {
  return element.getClientRects().length > 0 && !element.closest('[hidden], [inert]');
}
function first(panel: Element, selector: string): HTMLElement | undefined {
  return [...panel.querySelectorAll<HTMLElement>(selector)].find(element => shown(element) && element.matches(FOCUSABLE));
}

/** Where the focus goes in a panel: its text box, its current item, or its first control. */
export function panelEntry(panel: Element): HTMLElement | undefined {
  return first(panel, TEXT_BOX) ?? first(panel, CURRENT) ?? first(panel, FOCUSABLE);
}

/** Moves the focus to the next (or previous) panel; false when no panel on screen can take it. */
export function focusNextPanel(root: Document, backwards: boolean): boolean {
  const panels = [...root.querySelectorAll(FOCUS_PANELS)].filter(panel => shown(panel) && panelEntry(panel))
    // A panel inside another (a tile's details inside Window mode's stage) belongs to the outer one.
    .filter((panel, _index, all) => !all.some(other => other !== panel && other.contains(panel)));
  const active = root.activeElement;
  const index = nextPanelIndex(panels.length, active ? panels.findIndex(panel => panel.contains(active)) : -1, backwards);
  const target = index === undefined ? undefined : panelEntry(panels[index]!);
  if (!target) return false;
  target.focus({ preventScroll: false });
  return true;
}
