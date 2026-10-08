import { expect, type Locator } from '@playwright/test';

export async function revealComposerAction(view: Locator, name: string, keyboard = false) {
  const toolbar = view.locator('.agent-session-toolbar');
  const direct = toolbar.getByRole('button', { name, exact: true });
  if (await direct.isVisible()) return { action: direct, trigger: direct };

  const more = toolbar.getByRole('button', { name: 'More actions', exact: true });
  await expect(more).toBeVisible();
  const menu = view.getByRole('region', { name: 'More actions', exact: true });
  if (!await menu.isVisible()) {
    if (keyboard) { await more.focus(); await more.press('Enter'); }
    else await more.click();
  }
  const action = menu.getByRole('button', { name, exact: true });
  await expect(direct.or(action)).toBeVisible();
  if (await direct.isVisible()) {
    await more.press('Escape');
    await expect(menu).toBeHidden();
    return { action: direct, trigger: direct };
  }
  return { action, trigger: more };
}

export async function activateComposerAction(view: Locator, name: string, keyboard = false) {
  const { action, trigger } = await revealComposerAction(view, name, keyboard);
  if (keyboard) { await action.focus(); await action.press('Enter'); }
  else await action.click();
  return trigger;
}
