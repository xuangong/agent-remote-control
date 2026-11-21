// @vitest-environment jsdom
// The session actions beside a timeline: always shown in a wide heading, behind one disclosure in a narrow one.
import { act, useRef } from 'react';
import { expect, it, vi } from 'vitest';
import { render } from '../test/setup.js';
import { SessionTimelineTools } from './SessionTimelineTools.js';

function Harness({ collapsible, searchOpen = false, onDismissSearch = () => {} }: { collapsible: boolean; searchOpen?: boolean; onDismissSearch?(): void }) {
  const timeline = useRef<HTMLDivElement>(null);
  return <><SessionTimelineTools collapsible={collapsible} searchOpen={searchOpen} timelineRef={timeline} onDismissSearch={onDismissSearch}>
    <button type="button">Share</button>
  </SessionTimelineTools><div ref={timeline} data-testid="timeline" tabIndex={0}>Reading</div><button type="button" id="outside">Outside</button></>;
}
const toggle = (view: HTMLElement) => view.querySelector<HTMLButtonElement>('.lab-timeline-tools-toggle');
const content = (view: HTMLElement) => view.querySelector<HTMLElement>('.lab-timeline-tools-content')!;

it('offers no disclosure in a wide heading, whose actions are always reachable', async () => {
  const view = await render(<Harness collapsible={false} />);
  expect(toggle(view)).toBeNull();
  expect(content(view).hasAttribute('inert')).toBe(false);
  expect(content(view).getAttribute('aria-hidden')).toBeNull();
});

it('starts collapsed in a narrow heading, with the actions out of reach, and one control to expand them', async () => {
  const view = await render(<Harness collapsible />);
  expect(toggle(view)!.getAttribute('aria-label')).toBe('Expand session actions');
  expect(toggle(view)!.getAttribute('aria-expanded')).toBe('false');
  expect(content(view).hasAttribute('inert')).toBe(true);
  expect(content(view).getAttribute('aria-hidden')).toBe('true');
});

it('expands and collapses with the one control, keeping focus on it', async () => {
  const view = await render(<Harness collapsible />);
  await act(async () => toggle(view)!.click());
  expect(toggle(view)!.getAttribute('aria-label')).toBe('Collapse session actions');
  expect(toggle(view)!.getAttribute('aria-expanded')).toBe('true');
  expect(content(view).hasAttribute('inert')).toBe(false);
  const share = content(view).querySelector('button')!;
  share.focus();
  await act(async () => toggle(view)!.click());
  expect(content(view).hasAttribute('inert')).toBe(true);
  expect(document.activeElement).toBe(toggle(view));
});

it('collapses when the reader touches or scrolls the timeline, or presses outside, but not when they use the actions', async () => {
  const view = await render(<Harness collapsible />);
  const expand = async () => { if (toggle(view)!.getAttribute('aria-expanded') === 'false') await act(async () => toggle(view)!.click()); };
  const collapsed = () => toggle(view)!.getAttribute('aria-expanded') === 'false';
  await expand();
  await act(async () => { content(view).querySelector('button')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(collapsed()).toBe(false);
  await act(async () => { view.querySelector('#outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(collapsed()).toBe(true);
  await expand();
  await act(async () => { view.querySelector('[data-testid="timeline"]')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true })); });
  expect(collapsed()).toBe(true);
  await expand();
  await act(async () => { view.querySelector('[data-testid="timeline"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })); });
  expect(collapsed()).toBe(true);
  await expand();
  await act(async () => { view.querySelector('#outside')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })); });
  expect(collapsed()).toBe(false);
});

it('stays open, with its control disabled, while a search is open, and asks the search to close when it collapses', async () => {
  const dismiss = vi.fn();
  const view = await render(<Harness collapsible searchOpen onDismissSearch={dismiss} />);
  expect(toggle(view)!.disabled).toBe(true);
  expect(content(view).hasAttribute('inert')).toBe(false);
  await act(async () => { view.querySelector('#outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
  expect(dismiss).toHaveBeenCalledOnce();
});
