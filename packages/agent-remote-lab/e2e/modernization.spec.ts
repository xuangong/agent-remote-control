import { showNewSession } from './session-navigation';
import { toggleViewPanel } from './view-options';
import { expect, test, type Locator, type Page } from '@playwright/test';

interface Rgba { red: number; green: number; blue: number; alpha: number }
interface Rgb { red: number; green: number; blue: number }

const focusableSelector = 'button:not(:disabled):not([tabindex^="-"]), a[href]:not([tabindex^="-"]), input:not(:disabled):not([tabindex^="-"]), select:not(:disabled):not([tabindex^="-"]), textarea:not(:disabled):not([tabindex^="-"]), [tabindex]:not([tabindex^="-"])';

test('names the active connection state without relying on its marker', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await openRecordedSession(page);

  const summary = page.getByTestId('connection-summary');
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('Ready');
  await expect(summary).toHaveAccessibleName(`Recorded semantic Provider. Agent ${new URL(page.url()).searchParams.get('agent')}. Ready`);
  expectBrowserErrors(browserErrors);
});

test('opens session settings above the composer without moving the conversation', async ({ page }) => {
  await openRecordedSession(page);
  const timeline = page.getByTestId('timeline');
  const before = (await timeline.boundingBox())!;
  const model = page.getByTestId('session-model-button');
  await model.click();
  await expect(page.getByRole('region', { name: 'Model settings', exact: true })).toBeVisible();
  expect((await timeline.boundingBox())!.height).toBe(before.height);
  await model.press('Escape');
  await expect(page.getByRole('region', { name: 'Model settings', exact: true })).toHaveCount(0);
  await expect(model).toBeFocused();
  await page.getByRole('button', { name: 'Status', exact: true }).click();
  await expect(page.getByRole('switch', { name: 'Planning mode' })).toBeVisible();
  await page.getByTestId('prompt-input').click();
  await expect(page.getByRole('region', { name: 'Session status', exact: true })).toHaveCount(0);
  const send = (await page.getByTestId('prompt-submit').boundingBox())!;
  const composer = (await page.locator('.agent-composer').boundingBox())!;
  expect(send.x + send.width).toBeLessThanOrEqual(composer.x + composer.width);
  expect(send.y + send.height).toBeLessThanOrEqual(composer.y + composer.height);
  expect(composer.x + composer.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('keeps one View entry fixed while toggling panels and preserving the chat', async ({ page }, testInfo) => {
  await openRecordedSession(page);
  const input = page.getByTestId('prompt-input');
  await input.fill('Keep this draft');
  const trigger = page.getByRole('button', { name: 'View options', exact: true });
  const origin = (await trigger.boundingBox())!;
  const assertFixed = async () => {
    await expect(trigger).toHaveCount(1);
    const bounds = (await trigger.boundingBox())!;
    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: origin.x, y: origin.y });
  };
  const timeline = page.getByTestId('timeline');
  const height = (await timeline.boundingBox())!.height;
  await toggleViewPanel(page, 'Header');
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  expect((await timeline.boundingBox())!.height).toBeGreaterThan(height);
  await assertFixed();
  await expect(trigger).toBeFocused();
  if (testInfo.project.name === 'chromium-desktop') {
    const width = (await timeline.boundingBox())!.width;
    await toggleViewPanel(page, 'Sidebar');
    await expect(page.locator('#lab-context')).toBeHidden();
    expect((await timeline.boundingBox())!.width).toBeGreaterThan(width);
    await assertFixed();
    await toggleViewPanel(page, 'Header');
    await assertFixed();
    await toggleViewPanel(page, 'Sidebar');
    await expect(page.locator('#lab-context')).toBeVisible();
    await assertFixed();
  } else {
    await toggleViewPanel(page, 'Sidebar');
    await expect(page.getByRole('dialog', { name: 'Context' })).toBeVisible();
    await page.getByRole('button', { name: 'Close Context' }).press('Escape');
    await expect(trigger).toBeFocused();
    await assertFixed();
    await toggleViewPanel(page, 'Header');
  }
  await expect(input).toHaveValue('Keep this draft');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await toggleViewPanel(page, 'Header');
  await assertFixed();
  await toggleViewPanel(page, 'Replica Inspector');
  await expect(page.locator('#lab-inspector')).toBeVisible();
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Close Replica Inspector' }).press('Escape');
  else await toggleViewPanel(page, 'Replica Inspector');
  await toggleViewPanel(page, 'Header');
  await expect(page.getByRole('tab', { name: 'Trace', exact: true })).toHaveAttribute('aria-selected', 'true');
  await trigger.click();
  await expect(page.getByRole('checkbox', { name: 'Header', exact: true })).toBeChecked();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await options.getByRole('button', { name: 'Hide all', exact: true }).click();
  await expect(options.locator('input:checked')).toHaveCount(0);
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  await expect(page.locator('#lab-context')).toBeHidden();
  await expect(page.locator('#lab-inspector')).toBeHidden();
  await assertFixed();
  if (testInfo.project.name === 'chromium-desktop') {
    await options.getByRole('button', { name: 'Show all', exact: true }).click();
    await expect(options.locator('input:checked')).toHaveCount(3);
    await expect(page.locator('.lab-app-bar')).toBeVisible();
    await expect(page.locator('#lab-context')).toBeVisible();
    await expect(page.locator('#lab-inspector')).toBeVisible();
    await options.getByRole('button', { name: 'Show all', exact: true }).click();
    await expect(options.locator('input:checked')).toHaveCount(3);
    await options.getByRole('button', { name: 'Hide all', exact: true }).click();
    await expect(options.locator('input:checked')).toHaveCount(0);
    await options.getByRole('button', { name: 'Show all', exact: true }).click();
  } else {
    await expect(options.getByRole('button', { name: 'Show all', exact: true })).toHaveCount(0);
    await options.getByRole('checkbox', { name: 'Header', exact: true }).check();
  }
  await assertFixed();
  if (await options.isVisible()) await options.press('Escape');
  await page.getByRole('tab', { name: 'Trace', exact: true }).click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('keeps Context and Replica Inspector keyboard-contained on compact layouts', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');

  await page.getByRole('button', { name: 'Close Context' }).press('Escape');
  const contextTrigger = page.getByRole('button', { name: 'View options', exact: true });
  await expect(page.getByRole('button', { name: 'Open sessions', exact: true })).toBeFocused();
  await toggleViewPanel(page, 'Sidebar');
  await assertKeyboardContained(page, 'Context', contextTrigger);

  await toggleViewPanel(page, 'Sidebar');
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);

  const inspectorTrigger = page.getByRole('button', { name: 'View options', exact: true });
  await toggleViewPanel(page, 'Replica Inspector');
  await assertKeyboardContained(page, 'Replica Inspector', inspectorTrigger);
  expectBrowserErrors(browserErrors);
});

test('keeps command feedback visible in compact layout', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const browserErrors = collectBrowserErrors(page);
  await openRecordedSession(page);
  await toggleViewPanel(page, 'Sidebar');
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('playback-advance').click();

  const feedback = page.getByText('Recorded observation advanced.');
  await expect(feedback).toBeVisible();
  const bounds = await feedback.boundingBox();
  expect(bounds?.width ?? 0).toBeGreaterThan(0);
  expect(bounds?.height ?? 0).toBeGreaterThan(0);
  expectBrowserErrors(browserErrors);
});

test('meets AA contrast for operational text and primary actions', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  const primaryAction = page.getByTestId('session-create');
  await expect(primaryAction).toBeEnabled();
  await primaryAction.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
  });
  const primaryContrast = await renderedContrast(primaryAction);
  await primaryAction.click();
  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);

  const failedResource = page.locator('.agent-resources li').filter({ hasText: 'artifacts/failed.txt' });
  const errorText = failedResource.getByText('Failed', { exact: true });
  await expect(errorText).toBeVisible();

  const measured = {
    primaryAction: primaryContrast,
    sessionSummary: await renderedContrast(page.getByTestId('connection-summary')),
    secondaryText: await renderedContrast(page.getByTestId('workbench').locator('.lab-workbench-heading > span')),
    errorText: await renderedContrast(errorText),
  };
  for (const [name, ratio] of Object.entries(measured)) expect(ratio, name).toBeGreaterThanOrEqual(4.5);
  expectBrowserErrors(browserErrors);
});

test('renders a visible focus indicator with three-to-one contrast', async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await showNewSession(page);
  const provider = page.getByTestId('provider-select');
  await provider.focus();

  const outline = await provider.evaluate((element) => {
    const style = getComputedStyle(element);
    const asRgba = (value: string): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas color conversion is unavailable.');
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`;
    };
    let parent: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (parent) {
      const candidate = getComputedStyle(parent).backgroundColor;
      if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') {
        background = candidate;
        break;
      }
      parent = parent.parentElement;
    }
    return { color: asRgba(style.outlineColor), width: style.outlineWidth, style: style.outlineStyle, background: asRgba(background) };
  });
  const outlineColor = parseCssColor(outline.color);
  const background = parseCssColor(outline.background);
  const ratio = contrastRatio(composite(outlineColor, background), background);

  expect(outline.style).toBe('solid');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
  expect(ratio).toBeGreaterThanOrEqual(3);
  expectBrowserErrors(browserErrors);
});

test('renders default control boundaries with three-to-one contrast', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop');
  const browserErrors = collectBrowserErrors(page);
  await openRecordedSession(page);
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('playback-advance').click();

  const controls = {
    button: page.getByRole('button', { name: 'Load resource', exact: true }),
    select: page.getByTestId('provider-select'),
    input: page.locator('.agent-question-custom input'),
  };
  for (const [name, control] of Object.entries(controls)) {
    await expect(control).toBeVisible();
    expect(await renderedBorderContrast(control), name).toBeGreaterThanOrEqual(3);
  }
  expectBrowserErrors(browserErrors);
});

test('provides coarse-pointer controls at least forty-four pixels wide and high', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile');
  const browserErrors = collectBrowserErrors(page);
  await page.goto('/');
  await assertMinimumSize(page.getByRole('button', { name: 'View options', exact: true, includeHidden: true }), 44);
  await showNewSession(page);
  await assertMinimumSize(page.locator('.lab-provider-controls button'), 44);

  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);
  await page.getByRole('button', { name: 'Load resource' }).click();
  await toggleViewPanel(page, 'Header');
  await assertMinimumSize(page.locator('.lab-app-bar button'), 44);
  const resourceLinks = page.getByRole('link', { name: /resource/ });
  await expect(resourceLinks.first()).toBeVisible();
  await assertMinimumSize(resourceLinks, 44);
  await toggleViewPanel(page, 'Sidebar');
  if (testInfo.project.name === 'chromium-mobile') await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByTestId('playback-advance').click();
  await page.getByRole('button', { name: 'Close Context' }).click();

  await assertMinimumSize(page.getByLabel('Live provider controls').locator('button'), 44);
  await assertMinimumSize(page.locator('.agent-interaction button'), 44);
  await assertMinimumSize(page.locator('.agent-question-options > label'), 44);
  expectBrowserErrors(browserErrors);
});

async function openRecordedSession(page: Page): Promise<void> {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('provider-select').selectOption({ label: 'Recorded semantic Provider' });
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('timeline').locator('.agent-timeline-entry')).toHaveCount(6);
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  await toggleViewPanel(page, 'Header');
}

async function assertKeyboardContained(page: Page, label: string, trigger: Locator): Promise<void> {
  const dialog = page.getByRole('dialog', { name: label });
  const close = dialog.getByRole('button', { name: `Close ${label}` });
  await expect(close).toBeFocused();

  const controls = dialog.locator(focusableSelector);
  const last = controls.last();
  await last.focus();
  await last.press('Tab');
  await expect(close).toBeFocused();
  await close.press('Shift+Tab');
  await expect(last).toBeFocused();

  await dialog.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function renderedContrast(locator: Locator): Promise<number> {
  const colors = await locator.evaluate((element) => {
    const asRgba = (value: string): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas color conversion is unavailable.');
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`;
    };
    const foreground = getComputedStyle(element).color;
    let parent: Element | null = element;
    let background = 'rgba(0, 0, 0, 0)';
    while (parent) {
      const candidate = getComputedStyle(parent).backgroundColor;
      if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') {
        background = candidate;
        break;
      }
      parent = parent.parentElement;
    }
    return { foreground: asRgba(foreground), background: asRgba(background) };
  });
  const foreground = parseCssColor(colors.foreground);
  const background = parseCssColor(colors.background);
  return contrastRatio(composite(foreground, background), background);
}

async function renderedBorderContrast(locator: Locator): Promise<number> {
  const colors = await locator.evaluate((element) => {
    const asRgba = (value: string): string => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Canvas color conversion is unavailable.');
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      return `rgba(${red}, ${green}, ${blue}, ${(alpha ?? 255) / 255})`;
    };
    const style = getComputedStyle(element);
    let parent: Element | null = element;
    let background = style.backgroundColor;
    while ((background === 'rgba(0, 0, 0, 0)' || background === 'transparent') && parent.parentElement) {
      parent = parent.parentElement;
      background = getComputedStyle(parent).backgroundColor;
    }
    return { border: asRgba(style.borderTopColor), background: asRgba(background) };
  });
  const border = parseCssColor(colors.border);
  const background = parseCssColor(colors.background);
  return contrastRatio(composite(border, background), background);
}

async function assertMinimumSize(locator: Locator, minimum: number): Promise<void> {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);
  let visibleCount = 0;
  for (let index = 0; index < count; index += 1) {
    const control = locator.nth(index);
    if (!await control.isVisible()) continue;
    visibleCount += 1;
    const bounds = await control.boundingBox();
    const label = await control.getAttribute('aria-label') ?? await control.textContent() ?? `control ${index + 1}`;
    expect(bounds?.width ?? 0, `${label.trim()} width`).toBeGreaterThanOrEqual(minimum);
    expect(bounds?.height ?? 0, label.trim()).toBeGreaterThanOrEqual(minimum);
  }
  expect(visibleCount).toBeGreaterThan(0);
}

export function parseCssColor(value: string): Rgba {
  const match = /^rgba?\((.*)\)$/.exec(value.trim());
  if (!match?.[1]) throw new Error(`Expected an rgb() or rgba() color, received ${value}.`);
  const [channelsPart, alphaPart] = match[1].replaceAll(',', ' ').split('/').map((part) => part.trim());
  const channels = channelsPart?.split(/\s+/).map(Number) ?? [];
  const inlineAlpha = alphaPart === undefined && channels.length === 4 ? channels.pop() : undefined;
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) {
    throw new Error(`Expected three RGB channels, received ${value}.`);
  }
  const alpha = alphaPart === undefined ? inlineAlpha ?? 1 : Number(alphaPart);
  return { red: channels[0]!, green: channels[1]!, blue: channels[2]!, alpha };
}

export function composite(foreground: Rgba, background: Rgba): Rgb {
  const backgroundAlpha = background.alpha + foreground.alpha * (1 - background.alpha);
  if (backgroundAlpha === 0) return { red: 0, green: 0, blue: 0 };
  return {
    red: (foreground.red * foreground.alpha + background.red * background.alpha * (1 - foreground.alpha)) / backgroundAlpha,
    green: (foreground.green * foreground.alpha + background.green * background.alpha * (1 - foreground.alpha)) / backgroundAlpha,
    blue: (foreground.blue * foreground.alpha + background.blue * background.alpha * (1 - foreground.alpha)) / backgroundAlpha,
  };
}

export function relativeLuminance(color: Rgb): number {
  const linear = [color.red, color.green, color.blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

export function contrastRatio(left: Rgb, right: Rgb): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function collectBrowserErrors(page: Page): { console: string[]; page: string[] } {
  const errors = { console: [] as string[], page: [] as string[] };
  page.on('console', (message) => { if (message.type() === 'error') errors.console.push(message.text()); });
  page.on('pageerror', (error) => errors.page.push(error.message));
  return errors;
}

function expectBrowserErrors(errors: { console: string[]; page: string[] }): void {
  expect(errors.console).toEqual([]);
  expect(errors.page).toEqual([]);
}
