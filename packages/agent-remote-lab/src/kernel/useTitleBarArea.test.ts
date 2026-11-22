import { expect, it } from 'vitest';
import { titleBarArea, type WindowControlsOverlay } from './useTitleBarArea.js';

const overlay = (visible: boolean, rect = { x: 78, y: 0, width: 1362, height: 28 }): WindowControlsOverlay =>
  Object.assign(new EventTarget(), { visible, getTitlebarAreaRect: () => rect });

it.each([
  ['a browser without the overlay', undefined, undefined],
  ['an app window that shows its own title bar', overlay(false), undefined],
  ['an app window that gives its title bar to the page, right of macOS\'s traffic lights', overlay(true), { x: 78, y: 0, width: 1362, height: 28 }],
  ['one left of Windows\'s controls', overlay(true, { x: 0, y: 0, width: 1302, height: 33 }), { x: 0, y: 0, width: 1302, height: 33 }],
  ['an overlay that reports no area yet', overlay(true, { x: 0, y: 0, width: 0, height: 0 }), undefined],
] as const)('reads %s', (_name, source, area) => {
  expect(titleBarArea(source)).toEqual(area);
});
