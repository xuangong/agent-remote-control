import { expect, test } from '@playwright/test';

const root = `/work/${'long-workspace-name-'.repeat(8)}projects`;
const page1 = { path: root, parentPath: '/work', roots: [root], folders: [{ name: 'My project', path: `${root}/My project` }], nextOffset: null };

test.beforeEach(async ({ page }) => {
  await page.route('**/v1/remote/workspaces?*', route => route.fulfill({ json: { workspaces: [{ id: 'root', name: 'Projects', path: root }] } }));
  await page.route('**/v1/remote/workspace-folders?*', route => route.fulfill({ json: page1 }));
  await page.route('**/v1/remote/workspace-folders/create', route => route.fulfill({ status: 409, json: { error: 'A folder with this name already exists.' } }));
  await page.goto(`/e2e/fixtures/workspace-picker.html?path=${encodeURIComponent(root)}`);
});

test('the folder picker stays inside the viewport, including its creation form with an error, on a 320px phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.getByRole('button', { name: 'Browse…' }).click();
  const modal = page.getByRole('dialog', { name: 'Choose a workspace folder' });
  await expect(modal.getByRole('button', { name: 'My project' })).toBeVisible();
  const frame = () => modal.evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, overflow: element.scrollWidth - element.clientWidth }));
  const listing = await frame();
  expect(listing.left).toBeGreaterThanOrEqual(0);
  expect(listing.right).toBeLessThanOrEqual(320);
  await modal.getByRole('button', { name: 'New folder', exact: true }).click();
  await modal.getByLabel('New folder name').fill('My project');
  await modal.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(modal.getByRole('alert')).toContainText('already exists');
  expect((await frame()).overflow).toBeLessThanOrEqual(1);
});
