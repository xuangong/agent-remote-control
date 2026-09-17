import { expect, test } from '@playwright/test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let root: string;
test.beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'arc-folder-picker-')));
  await mkdir(join(root, 'My project')); await mkdir(join(root, '.hidden')); await writeFile(join(root, 'not-a-folder.txt'), 'text');
});
test.afterAll(async () => { await rm(root, { recursive: true, force: true }); });
test.beforeEach(async ({ page }) => { await page.goto(`/e2e/fixtures/workspace-picker.html?path=${encodeURIComponent(root)}`); });

test('browses real Controller folders, confirms a selection, and restores focus', async ({ page }, info) => {
  await page.getByRole('button', { name: 'Browse…' }).click();
  const modal = page.getByRole('dialog', { name: 'Choose a workspace folder' });
  await expect(modal.getByRole('button', { name: 'My project' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '.hidden', exact: true })).toHaveCount(0);
  await expect(modal.getByText('not-a-folder.txt')).toHaveCount(0);
  await modal.getByLabel('Hidden folders').check();
  await expect(modal.getByRole('button', { name: '.hidden' })).toBeVisible();
  await modal.getByLabel('Filter folders').fill('My project');
  await expect(modal.getByRole('button', { name: '.hidden', exact: true })).toHaveCount(0);
  await modal.getByRole('button', { name: 'My project' }).click();
  await expect(modal.getByText('No subfolders. You can select the current folder.')).toBeVisible();
  await expect(modal.getByLabel('Folder path')).toHaveValue(join(root, 'My project'));
  const bounds = await modal.evaluate(element => ({ right: element.getBoundingClientRect().right, left: element.getBoundingClientRect().left, width: innerWidth }));
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: info.outputPath('workspace-folder-picker.png') });
  await modal.getByRole('button', { name: 'Select folder' }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.getByTestId('selected-folder')).toHaveText(join(root, 'My project'));
  await expect(page.getByRole('button', { name: 'Browse…' })).toBeFocused();
});

test('retains the previous choice on cancel and recovers from an invalid path', async ({ page }) => {
  await page.getByRole('button', { name: 'Browse…' }).click();
  const modal = page.getByRole('dialog', { name: 'Choose a workspace folder' });
  await expect(modal.getByRole('button', { name: 'My project' })).toBeVisible();
  await modal.getByRole('button', { name: 'My project' }).click();
  await expect(modal.getByRole('button', { name: 'Parent folder' })).toBeEnabled();
  await modal.getByRole('button', { name: 'Parent folder' }).click();
  await expect(modal.getByRole('button', { name: 'My project' })).toBeVisible();
  await modal.getByLabel('Folder path').fill(join(root, 'missing'));
  await modal.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('folder cannot be opened');
  await expect(modal.getByRole('button', { name: 'Select folder' })).toBeDisabled();
  await modal.getByLabel('Folder path').fill(root);
  await modal.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(modal.getByRole('button', { name: 'My project' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(modal).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'New session', exact: true })).toBeVisible();
  await expect(page.getByTestId('selected-folder')).toHaveText(root);
});
