import { expect, type Locator } from '@playwright/test';

/**
 * Shows an action of the composer's "+" menu (I4): opens the menu with "+" (named More actions) when it is closed, and returns the
 * item and the trigger that focus comes back to.
 */
export async function revealComposerAction(view: Locator, name: string, keyboard = false) {
  const more = view.locator('.agent-composer-capsule').getByRole('button', { name: 'More actions', exact: true });
  await expect(more).toBeVisible();
  const menu = view.getByRole('region', { name: 'More actions', exact: true });
  if (!await menu.isVisible()) {
    if (keyboard) { await more.focus(); await more.press('Enter'); }
    else await more.click();
  }
  const action = menu.getByRole('button', { name, exact: true });
  await expect(action).toBeVisible();
  return { action, trigger: more };
}

export async function activateComposerAction(view: Locator, name: string, keyboard = false) {
  const { action, trigger } = await revealComposerAction(view, name, keyboard);
  if (keyboard) { await action.focus(); await action.press('Enter'); }
  else await action.click();
  return trigger;
}
