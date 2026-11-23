// Component projects: webkit-ask-desktop, orchard-phone-chromium, orchard-phone-webkit
import { clickSessionAction, showSessionAction } from '../session-actions';
import { expect, test } from '@playwright/test';
const team={id:'team',operationId:'create',revision:1,title:'Diagnose across Hosts',status:'active',source:{hostId:'mac',providerId:'codex',nativeSessionId:'source',title:'Project'},createdAt:1,updatedAt:1,messages:[],members:[
 {id:'leader',name:'Leader',role:'leader',hostId:'mac',providerId:'codex',nativeSessionId:'leader',creation:'ready',activity:'idle',responsibility:'Discuss and implement',summary:'',updatedAt:1},
 {id:'member',name:'Windows validation',role:'member',hostId:'win',providerId:'codex',nativeSessionId:'member',creation:'ready',activity:'idle',responsibility:'Check service logs',summary:'',updatedAt:1},
]};
test.beforeEach(async({page})=>{
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[team]}}));
 await page.route('**/v1/remote/hosts/*/attach',route=>route.fulfill({json:{agentId:route.request().postDataJSON().nativeSessionId}}));
});

test('Team sessions each send to their own session and settle their own message on its echo', async ({ page, isMobile }) => {
 await page.goto('/e2e/fixtures/team.html?send=manual');
 const teams = page.getByRole('button', { name: 'Teams', exact: true });
 await teams.click(); await page.getByRole('button', { name: /Diagnose across Hosts/ }).click();
 const targets: Array<[string, string]> = isMobile ? [['Leader', 'leader'], ['Windows validation', 'member']] : [['Project', 'source'], ['Leader', 'leader'], ['Windows validation', 'member']];
 for (const [title, id] of targets) {
  if (isMobile && id === 'member') {
   await teams.click();
   await page.getByRole('navigation', { name: 'Diagnose across Hosts sessions', exact: true }).getByRole('button', { name: /^Windows validation/ }).click();
  }
  const pane = page.getByRole('region', { name: title, exact: true });
  const input = pane.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  const text = `Confirmed Team input for ${id}`;
  await input.fill(text); await pane.getByTestId('prompt-submit').click();
  await expect(page.locator('html')).toHaveAttribute('data-fixture-input-target', id);
  // The composer hands the text to the pane's outgoing message, which waits for the echo of its own session.
  await expect(input).toHaveValue('');
  await expect(pane.locator('.agent-outgoing-message')).toContainText(text);
  await expect(pane.locator('.agent-outgoing-message')).toContainText('Sending');
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('fixture:settle-input', { detail: { id, outcome: 'echo' } })), id);
  await expect(pane.locator('.agent-message-user')).toContainText(text);
  await expect(pane.locator('.agent-outgoing-message')).toHaveCount(0);
  await page.evaluate(id => window.dispatchEvent(new CustomEvent('fixture:settle-input', { detail: { id, outcome: 'ack' } })), id);
  await expect.poll(() => page.evaluate(text => Object.values(JSON.parse(sessionStorage.getItem('agent-remote:recovery:team-fixture:drafts') ?? '{}')).includes(text), text)).toBe(false);
 }
 await page.reload();
 await expect(page.getByRole('region', { name: isMobile ? 'Windows validation' : 'Leader', exact: true }).getByTestId('prompt-input')).toHaveValue('');
});
test('compact Team navigation opens a member with its own editable permissions and returns to the Leader', async ({ page, isMobile }, info) => {
 test.skip(!isMobile, 'Compact Team navigation replaces the single visible session.');
 const { activateComposerAction } = await import('../composer-actions');
 const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
 await page.goto('/e2e/fixtures/team.html?settings');
 const trigger = page.getByRole('button', { name: 'Teams', exact: true });
 await trigger.click(); await page.getByRole('button', { name: /Diagnose across Hosts/ }).click();
 await expect(page.getByRole('region', { name: 'Leader', exact: true }).getByTestId('prompt-input')).toBeEnabled();
 await trigger.click();
 const navigation = page.getByRole('navigation', { name: 'Diagnose across Hosts sessions', exact: true });
 await expect(navigation.getByRole('button', { name: /^Leader/ })).toHaveAttribute('aria-current', 'page');
 await page.screenshot({ path: info.outputPath('team-member-switcher.png') });
 await navigation.getByRole('button', { name: /^Windows validation/ }).click();
 const member = page.getByRole('region', { name: 'Windows validation', exact: true });
 await expect(member.getByTestId('prompt-input')).toBeEnabled();
 await expect(page.locator('.lab-session-family-pane:visible')).toHaveCount(1);
 await activateComposerAction(member, 'Permissions');
 const policy = member.getByRole('combobox', { name: 'Approval policy', exact: true });
 await expect(policy).toBeEnabled(); await policy.selectOption('allow');
 await expect(page.locator('html')).toHaveAttribute('data-fixture-setting-target', 'member');
 await expect(policy).toHaveValue('allow');
 await page.keyboard.press('Escape');
 await page.reload(); await expect(member.getByTestId('prompt-input')).toBeEnabled();
 await trigger.click();
 await expect(navigation.getByRole('button', { name: /^Windows validation/ })).toHaveAttribute('aria-current', 'page');
 await navigation.getByRole('button', { name: /^Leader/ }).click();
 const leader = page.getByRole('region', { name: 'Leader', exact: true });
 await expect(leader.getByTestId('prompt-input')).toBeEnabled();
 await activateComposerAction(leader, 'Permissions');
 await expect(leader.getByRole('combobox', { name: 'Approval policy', exact: true })).toHaveValue('ask');
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 expect(errors).toEqual([]);
});
test('Team opens a normal dock layout with responsive presentation and refresh recovery',async({page,isMobile},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const attaches:string[]=[];page.on('request',request=>{if(request.url().endsWith('/attach'))attaches.push(request.postDataJSON().nativeSessionId);});
 await page.goto('/e2e/fixtures/team.html');await page.getByRole('button',{name:'Teams',exact:true}).click();
 await page.getByRole('button',{name:/Diagnose across Hosts/}).click();
 await expect(page.locator('.lab-session-family-pane:visible')).toHaveCount(isMobile?1:3);
 await expect(page.locator('[data-testid="prompt-input"]:visible').first()).toBeVisible();
 if(isMobile){expect(attaches).toEqual(['leader']);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 else{
  expect(attaches.sort()).toEqual(['source','leader','member'].sort());
  const pane=page.getByRole('region',{name:'Docked Leader',exact:true}),before=(await pane.boundingBox())!;
  const handle=pane.getByRole('separator',{name:'Leader width',exact:true});await handle.focus();await page.keyboard.press('ArrowRight');
  await expect.poll(async()=>(await pane.boundingBox())!.width).toBeGreaterThan(before.width);
  expect(await page.locator('.lab-session-dock-rail').evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
 }
 await page.screenshot({path:info.outputPath('team.png')});
 await page.reload();await expect(page.locator('.lab-session-family-pane:visible')).toHaveCount(isMobile?1:3);
 expect(errors).toEqual([]);
});

test('Team names are edited in the floating list without opening or creating a Team', async ({ page }) => {
 let current = { ...team, title: 'New team' };
 const actions: unknown[] = [];
 let fail = false;
 await page.route('**/v1/remote/teams', route => route.fulfill({ json: { teams: [current] } }));
 await page.route('**/v1/remote/teams/action', async route => {
  const input = route.request().postDataJSON(); actions.push(input);
  if (fail) { await route.fulfill({ status: 503, json: { error: 'Rename unavailable' } }); return; }
  current = { ...current, title: input.title };
  await route.fulfill({ json: current });
 });
 await page.goto('/e2e/fixtures/team.html');
 const entry = page.getByRole('button', { name: 'Teams', exact: true });
 await entry.click();
 const panel = page.getByRole('region', { name: 'Teams', exact: true });
 await panel.getByRole('button', { name: 'Rename Team', exact: true }).click();
 await panel.getByRole('textbox', { name: 'Team name' }).fill('Canceled title');
 await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
 expect(actions).toEqual([]);
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
 await panel.locator('.lab-session-row').click();
 await expect(page.locator('.lab-session-family-pane:visible')).not.toHaveCount(0);

 await entry.click();
 await panel.getByRole('button', { name: 'Rename Team', exact: true }).click();
 const input = panel.getByRole('textbox', { name: 'Team name' });
 await input.fill('  Windows investigation  ');
 await panel.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(input).toHaveCount(0);

 await expect(panel.locator('.lab-session-row')).toContainText('Windows investigation');
 expect(actions).toEqual([{ action: 'rename', teamId: 'team', title: 'Windows investigation' }]);
 await expect(panel.getByRole('button', { name: 'New team', exact: true })).toHaveCount(1);
 fail = true;
 await panel.getByRole('button', { name: 'Rename Team', exact: true }).click();
 await input.fill('Keep this draft');
 await panel.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(panel.getByRole('alert')).toHaveText('Rename unavailable');
 await expect(input).toHaveValue('Keep this draft');

 await input.press('Escape');
 await expect(input).toHaveCount(0);
 await expect(panel).toBeVisible();
 expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});


test('Team subagents belong to their parent pane and keep other families intact', async ({ page, isMobile }, info) => {
 const requests: Array<{ providerId: string; parentNativeSessionId: string; nativeSessionId: string }> = [];
 await page.route('**/v1/remote/hosts/*/child/attach', route => {
  const input = route.request().postDataJSON(); requests.push(input);
  return route.fulfill({ json: { agentId: input.nativeSessionId, nativeSessionId: input.nativeSessionId } });
 });
 await page.goto('/e2e/fixtures/team.html?children');
 await page.getByRole('button', { name: 'Teams', exact: true }).click();
 await page.locator('.lab-session-row').filter({ hasText: team.title }).click();
 const pane = (name: string) => page.getByRole('region', {name,exact:true});
 const openChild = async (parent: string, child: string) => {
  const list = pane(parent).getByRole('group', { name: 'Session subagents', exact: true });
  await expect(list).toBeVisible();
  if (await list.getAttribute('open') === null) await list.locator('summary').click();
  await pane(parent).locator(`[data-child-session-id="${child}"]`).click();
  await expect(pane(child).getByTestId('prompt-input')).toBeVisible();
  if (!isMobile) await expect.poll(async () => {
   const box = (await pane(child).boundingBox())!;
   return Math.max(-box.x, box.x + box.width - page.viewportSize()!.width);
  }).toBeLessThanOrEqual(1);
 };
 await pane('Leader').getByTestId('prompt-input').fill('Keep Leader draft');
 await openChild('Leader', 'leader-child');
 if (isMobile) {
  await expect(page.locator('.lab-session-family-pane:visible')).toHaveCount(1);
  await clickSessionAction(pane('leader-child'), 'Back to Leader');
  await expect(pane('Leader').getByTestId('prompt-input')).toContainText('Keep Leader draft');
  await openChild('Leader', 'leader-child');
 } else {
  expect(await page.locator('.lab-session-family-pane').evaluateAll(nodes => nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(node => node.getAttribute('aria-label')))).toEqual(['Project', 'Leader', 'leader-child', 'Windows validation']);
  await pane('Leader').getByTestId('prompt-input').click();
  await expect(pane('leader-child')).toBeVisible();
 }
 await openChild('leader-child', 'leader-grandchild');
 if (isMobile) { await page.getByRole('button',{name:'Teams',exact:true}).click(); await page.locator('.lab-team-management > summary').click(); await page.locator('.lab-team-members').getByRole('button',{name:'Windows validation',exact:true}).click(); }
 await openChild('Windows validation', 'member-child');
 await page.screenshot({ path: info.outputPath('team-families.png') });
 if (isMobile) {
  await page.getByRole('button',{name:'Teams',exact:true}).click(); await page.locator('.lab-team-management > summary').click(); await page.locator('.lab-team-members').getByRole('button',{name:'Leader',exact:true}).click();
  await expect(pane('leader-grandchild')).toBeVisible();
 } else {
  expect(await page.locator('.lab-session-family-pane').evaluateAll(nodes => nodes.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(node => node.getAttribute('aria-label')))).toEqual(['Project', 'Leader', 'leader-child', 'leader-grandchild', 'Windows validation', 'member-child']);
  await pane('leader-child').getByRole('button', { name: 'Close subagent', exact: true }).click();
  await expect(pane('leader-child')).toHaveCount(0);
  await expect(pane('leader-grandchild')).toHaveCount(0);
  await expect(pane('member-child')).toBeVisible();
  await expect(pane('Leader').getByTestId('prompt-input')).toContainText('Keep Leader draft');
 }
 expect(requests.slice(0, 3).map(value => [value.parentNativeSessionId, value.nativeSessionId])).toEqual([
  ['leader', 'leader-child'], ['leader-child', 'leader-grandchild'], ['member', 'member-child'],
 ]);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.reload();
 await expect(pane(isMobile ? 'leader-grandchild' : 'member-child').getByTestId('prompt-input')).toBeVisible();
 if (!isMobile) await expect(pane('leader-child')).toHaveCount(0);
});

test('A subagent that cannot attach stays out of the panes, keeps its alert in the parent list and opens on retry', async ({ page, isMobile }) => {
 const requests: unknown[] = [];
 let fail = true;
 await page.route('**/v1/remote/hosts/*/child/attach', route => {
  const input = route.request().postDataJSON(); requests.push(input);
  return fail ? route.fulfill({ status: 503, json: { error: 'Child temporarily unavailable' } }) : route.fulfill({ json: { agentId: input.nativeSessionId, nativeSessionId: input.nativeSessionId } });
 });
 await page.goto('/e2e/fixtures/team.html?children');
 await page.getByRole('button', { name: 'Teams', exact: true }).click();
 await page.locator('.lab-session-row').filter({ hasText: team.title }).click();
 const parent = page.getByRole('region', { name: 'Leader', exact: true });
 await expect(parent.getByTestId('prompt-input')).toBeEnabled();
 await parent.getByTestId('prompt-input').fill('Keep Team draft');
 const list = parent.getByRole('group', { name: 'Session subagents', exact: true });
 await list.locator('summary').click();
 const row = parent.locator('[data-child-session-id="leader-child"]');
 await row.click();
 await expect(list.getByRole('alert')).toContainText('Child temporarily unavailable');
 await expect(page.getByRole('region', { name: 'leader-child', exact: true })).toHaveCount(0);
 fail = false;
 const attempts = requests.length;
 await row.click();
 const child = page.getByRole('region', { name: 'leader-child', exact: true });
 await expect(child.getByTestId('prompt-input')).toBeEnabled();
 await expect(list.getByRole('alert')).toHaveCount(0);
 expect(requests).toHaveLength(attempts + 1);
 expect(requests).toEqual(Array(requests.length).fill({ providerId: 'codex', parentNativeSessionId: 'leader', nativeSessionId: 'leader-child' }));
 if (isMobile) await clickSessionAction(child, 'Back to Leader'); else await clickSessionAction(child, 'Close subagent');
 await expect(parent.getByTestId('prompt-input')).toContainText('Keep Team draft');
});

test('Add member requires a selected Workspace and preserves the request identity after rejection', async ({ page }, info) => {
 const actions: any[] = [];
 let fail = true;
 await page.route('**/v1/remote/hosts/*/workspaces?*', route => route.fulfill({json:{workspaces:[{id:'project',name:'Project',path:'C:\\work\\project'}]}}));
 await page.route('**/v1/remote/teams/action', route => {
  const input = route.request().postDataJSON(); actions.push(input);
  return fail ? route.fulfill({status:503,json:{error:'Host temporarily unavailable'}}) : route.fulfill({json:team});
 });
 await page.goto('/e2e/fixtures/team.html');
 await page.getByRole('button',{name:'Teams',exact:true}).click();
 const panel=page.getByRole('region',{name:'Teams',exact:true});
 await panel.locator('.lab-team-management > summary').click();
 await panel.getByRole('button',{name:'Add member',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Add member',exact:true});
 await expect(dialog).toBeVisible();await dialog.getByRole('combobox',{name:'Host',exact:true}).selectOption('win');
 await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Windows investigator');
 const workspace=dialog.getByRole('combobox',{name:'Workspace',exact:true});
 await expect(workspace).toHaveValue('');
 await expect(dialog.getByRole('button',{name:'Add member',exact:true})).toBeDisabled();
 await expect(workspace.locator('option:checked')).toHaveText('Choose a workspace…');
 await expect(workspace).toBeEnabled();
 await workspace.selectOption('project');
 await expect(dialog.getByRole('button',{name:'Add member',exact:true})).toBeEnabled();
 await page.screenshot({path:info.outputPath('team-member-workspace.png')});
 await dialog.getByRole('button',{name:'Add member',exact:true}).click();
 await expect(dialog.getByRole('alert')).toBeVisible();
 await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Windows investigator');
 await expect(workspace).toHaveValue('project');
 fail=false;await dialog.getByRole('button',{name:'Add member',exact:true}).click();
 await expect(dialog).toHaveCount(0);expect(actions).toHaveLength(2);expect(actions[0]).toEqual(actions[1]);
 expect(actions[0]).toMatchObject({action:'add_member',teamId:'team',hostId:'win',providerId:'codex',name:'Windows investigator',cwd:'C:\\work\\project'});
 expect(actions[0].operationId).toEqual(expect.any(String));
 await expect(panel).toBeVisible();await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
 await panel.getByRole('button',{name:'Archive',exact:true}).click();
 expect(actions.at(-1)).toEqual({teamId:'team',action:'archive'});
});

test('Add member Browse isolates folder forms and preserves the draft when the picker closes', async ({ page, browserName }, info) => {
 const actions: any[] = [], folderRequests: Array<{hostId:string;providerId:string|null;path:string|null}> = [], creations: any[] = [];
 const root='C:\\work', chosen='C:\\work\\diagnostics', created='C:\\work\\diagnostics\\new-check';
 await page.route('**/v1/remote/hosts/*/workspaces?*', route => route.fulfill({json:{workspaces:[{id:'root',name:'Existing workspace',path:root}]}}));
 await page.route('**/v1/remote/hosts/*/workspace-folders?*', route => {
  const url=new URL(route.request().url()), path=url.searchParams.get('path') ?? root;
  folderRequests.push({hostId:url.pathname.split('/')[4]!,providerId:url.searchParams.get('providerId'),path:url.searchParams.get('path')});
  return route.fulfill({json:{path,parentPath:path===root?null:root,roots:[root],folders:[],nextOffset:null}});
 });
 await page.route('**/v1/remote/hosts/*/workspace-folders/create', route => {
  creations.push({hostId:new URL(route.request().url()).pathname.split('/')[4]!,...route.request().postDataJSON()});
  return route.fulfill({json:{path:created}});
 });
 await page.route('**/v1/remote/teams/action', route => {actions.push(route.request().postDataJSON());return route.fulfill({json:team});});
 await page.goto('/e2e/fixtures/team.html');
 await page.getByRole('button',{name:'Teams',exact:true}).click();
 const panel=page.getByRole('region',{name:'Teams',exact:true});
 await panel.locator('.lab-team-management > summary').click();
 await panel.getByRole('button',{name:'Add member',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Add member',exact:true});
 await dialog.getByRole('combobox',{name:'Host',exact:true}).selectOption('win');
 await dialog.getByRole('combobox',{name:'Provider',exact:true}).selectOption('claude-code');
 await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Windows diagnosis');
 await dialog.getByRole('textbox',{name:'Responsibility',exact:true}).fill('Inspect the service without changing configuration.');
 await dialog.getByRole('combobox',{name:'Workspace',exact:true}).selectOption('root');
 await expect(dialog.getByRole('button',{name:'Add member',exact:true})).toBeEnabled();
 const browse=dialog.getByRole('button',{name:'Browse…',exact:true});
 await browse.click();
 const picker=page.getByRole('dialog',{name:'Choose a workspace folder',exact:true});
 await expect(picker.getByLabel('Folder path')).toHaveValue(root);
 expect(folderRequests.at(-1)).toEqual({hostId:'win',providerId:'claude-code',path:root});
 // The first listing shows before a path is typed: a listing that arrives later writes its own path into the field (open item O58).
 await expect(picker.locator('footer > span')).toHaveText(root);
 await picker.getByLabel('Folder path').fill(chosen);
 await picker.getByRole('button',{name:'Go',exact:true}).click();
 await expect(picker.locator('footer > span')).toHaveText(chosen);
 expect(actions).toEqual([]);
 await picker.getByRole('button',{name:'New folder',exact:true}).click();
 await picker.getByLabel('New folder name').fill('new-check');
 await picker.getByLabel('New folder name').press('Enter');
 await expect(picker.getByLabel('Folder path')).toHaveValue(created);
 expect(creations).toEqual([{hostId:'win',providerId:'claude-code',parentPath:chosen,name:'new-check'}]);
 expect(actions).toEqual([]);
 const pickerBounds=await picker.boundingBox();
 expect(pickerBounds!.x).toBeGreaterThanOrEqual(0);
 expect(pickerBounds!.x+pickerBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 expect(await picker.evaluate(element=>element.scrollWidth-element.clientWidth)).toBeLessThanOrEqual(1);
 await page.screenshot({path:info.outputPath('team-member-folder-picker.png')});
 await page.keyboard.press('Escape');
 await expect(picker).toHaveCount(0);
 await expect(dialog).toBeVisible();
 await expect(browse).toBeFocused();
 await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Windows diagnosis');
 await expect(dialog.getByRole('textbox',{name:'Responsibility',exact:true})).toHaveValue('Inspect the service without changing configuration.');
 await expect(dialog.getByRole('combobox',{name:'Workspace',exact:true})).toHaveValue('root');
 await expect(dialog.getByRole('button',{name:'Add member',exact:true})).toBeEnabled();
 await browse.click();
 await expect(picker.getByRole('button',{name:'Select folder',exact:true})).toBeEnabled();
 await picker.getByRole('button',{name:'Close folder picker',exact:true}).click();
 await expect(dialog).toBeVisible();
 await expect(browse).toBeFocused();
 await browse.click();
 await expect(picker.getByRole('button',{name:'Select folder',exact:true})).toBeEnabled();
 await picker.getByLabel('Folder path').fill(created);
 await picker.getByLabel('Folder path').press('Enter');
 await expect(picker.locator('footer > span')).toHaveText(created);
 await picker.getByRole('button',{name:'Select folder',exact:true}).click();
 await expect(dialog.getByRole('combobox',{name:'Workspace',exact:true}).locator('option:checked')).toHaveText(created);
 await dialog.getByRole('button',{name:'Add member',exact:true}).click();
 await expect(dialog).toHaveCount(0);
 expect(actions).toHaveLength(1);
 expect(actions[0]).toMatchObject({hostId:'win',providerId:'claude-code',cwd:created,name:'Windows diagnosis'});
 expect(folderRequests.every(request=>request.hostId==='win'&&request.providerId==='claude-code')).toBe(true);
});

test('Add member clears Workspace selection when Host or Provider changes', async ({ page }) => {
 const requests: Array<{hostId:string;providerId:string|null}> = [];
 await page.route('**/v1/remote/hosts/*/workspaces?*', route => {
  const url=new URL(route.request().url()), hostId=url.pathname.split('/')[4]!, providerId=url.searchParams.get('providerId');
  requests.push({hostId,providerId});
  return route.fulfill({json:{workspaces:[{id:`${hostId}-${providerId}`,name:'Project',path:hostId==='mac'?'/work/project':`C:\\work\\${providerId}`}]}});
 });
 await page.goto('/e2e/fixtures/team.html');
 await page.getByRole('button',{name:'Teams',exact:true}).click();
 const panel=page.getByRole('region',{name:'Teams',exact:true});
 await panel.locator('.lab-team-management > summary').click();
 await panel.getByRole('button',{name:'Add member',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Add member',exact:true}), workspace=dialog.getByRole('combobox',{name:'Workspace',exact:true});
 const add=dialog.getByRole('button',{name:'Add member',exact:true});
 await workspace.selectOption('mac-codex');
 await expect(add).toBeEnabled();
 await dialog.getByRole('combobox',{name:'Host',exact:true}).selectOption('win');
 await expect(workspace).toHaveValue('');
 await expect(add).toBeDisabled();
 await workspace.selectOption('win-codex');
 await expect(add).toBeEnabled();
 await dialog.getByRole('combobox',{name:'Provider',exact:true}).selectOption('claude-code');
 await expect(workspace).toHaveValue('');
 await expect(add).toBeDisabled();
 await expect(workspace.locator('option[value="win-codex"]')).toHaveCount(0);
 await workspace.selectOption('win-claude-code');
 await expect(add).toBeEnabled();
 expect(requests).toEqual(expect.arrayContaining([{hostId:'mac',providerId:'codex'},{hostId:'win',providerId:'codex'},{hostId:'win',providerId:'claude-code'}]));
});

test('Applying another Team keeps existing docks and repeated opens do not duplicate sessions', async ({ page, isMobile }) => {
 test.skip(isMobile, 'Independent docks require a wide workspace.');
 await page.route('**/v1/remote/hosts/*/child/attach', route => {
  const nativeSessionId = route.request().postDataJSON().nativeSessionId;
  return route.fulfill({ json: { agentId: nativeSessionId, nativeSessionId } });
 });
 const other={...team,id:'other-team',title:'Other Team',source:{...team.source,nativeSessionId:'other-source',title:'Other project'},members:[{...team.members[0],id:'other-leader',nativeSessionId:'other-leader',name:'Other leader'}]};
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[team,other]}}));
 await page.goto('/e2e/fixtures/team.html?children');
 const open=async(title:string)=>{await page.getByRole('button',{name:'Teams',exact:true}).click();await page.locator('.lab-session-row').filter({hasText:title}).click();};
 await open(team.title);
 const leader=page.getByRole('region',{name:'Leader',exact:true});
 await leader.getByTestId('prompt-input').fill('Keep across Team opens');
 await expect(leader.getByTestId('prompt-submit')).toBeEnabled();
 await leader.getByRole('group', { name: 'Session subagents', exact: true }).locator('summary').click();await leader.locator('[data-child-session-id="leader-child"]').click();
 await expect(page.getByRole('region',{name:'leader-child',exact:true})).toBeVisible();
 await open(other.title);
 await expect(page.getByRole('region',{name:'Other project',exact:true})).toBeVisible();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(3);
 await expect(leader.getByTestId('prompt-input')).toContainText('Keep across Team opens');
 await expect(page.getByRole('region',{name:'leader-child',exact:true})).toBeVisible();
 await leader.locator('[data-session-title-draggable]').focus();await page.keyboard.press('Alt+ArrowRight');
 await expect(page.getByRole('region',{name:'Docked Leader',exact:true})).toHaveCSS('order','2');
 await expect(page.getByRole('region',{name:'Docked Leader',exact:true}).getByRole('region',{name:'leader-child',exact:true})).toBeVisible();
 await open(team.title);await expect(page.locator('.lab-session-dock-pane')).toHaveCount(3);
 await page.reload();await expect(page.locator('.lab-session-dock-pane')).toHaveCount(3);
 await expect(page.getByRole('region',{name:'Docked Leader',exact:true})).toHaveCSS('order','2');
 // Closing a member is independent; Gather restores it without changing the main.
 await page.getByRole('button',{name:'Close Windows validation',exact:true}).click();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(2);
 await expect(leader).toBeVisible();
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 const member=page.getByRole('region',{name:'Windows validation',exact:true});
 await member.getByRole('group', { name: 'Session subagents', exact: true }).locator('summary').click();
 await member.locator('[data-child-session-id="member-child"]').click();
 await expect(page.getByRole('region',{name:'member-child',exact:true})).toBeVisible();
 // The close group survives reload and floating a member out of the rail.
 await page.reload();
 await clickSessionAction(page, 'Float Windows validation');
 await page.getByRole('button',{name:'Close Leader',exact:true}).click();
 await expect(leader).toHaveCount(0);
 await expect(member).toHaveCount(0);
 await expect(page.getByRole('region',{name:'leader-child',exact:true})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'member-child',exact:true})).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Project',exact:true})).toBeVisible();
 await expect(page.getByRole('region',{name:'Other leader',exact:true})).toBeVisible();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(1);
 await page.reload();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(1);
 await expect(leader).toHaveCount(0);
 await expect(member).toHaveCount(0);
});

test('Gather uses the current roster and preserves existing floating members and the main session', async ({ page, isMobile }) => {
 test.skip(isMobile, 'Gathering dock windows requires a wide workspace.');
 let roster=structuredClone(team),fail=false;
 await page.route('**/v1/remote/teams',route=>fail?route.fulfill({status:503,json:{error:'Team catalog is temporarily unavailable.'}}):route.fulfill({json:{teams:[roster]}}));
 await page.goto('/e2e/fixtures/team.html');
 await page.getByRole('button',{name:'Teams',exact:true}).click();
 await page.locator('.lab-session-row').filter({hasText:team.title}).click();
 const leader=page.getByRole('region',{name:'Leader',exact:true}), member=page.getByRole('region',{name:'Windows validation',exact:true});
 await member.getByTestId('prompt-input').fill('Keep member draft');
 await clickSessionAction(member, 'Float Windows validation');
 await page.reload();
 await showSessionAction(member, 'Dock Windows validation');
 roster={...roster,members:[...roster.members,{...roster.members[1]!,id:'linux',nativeSessionId:'linux-member',name:'Linux validation'}]};
 fail=true;
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(leader.getByRole('alert')).toContainText('Team catalog is temporarily unavailable.');
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toHaveCount(0);
 fail=false;
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toBeVisible();
 await showSessionAction(member, 'Dock Windows validation');
 await expect(member.getByTestId('prompt-input')).toContainText('Keep member draft');
 await expect(page.getByRole('region',{name:'Project',exact:true})).toBeVisible();
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(2);
 await leader.getByRole('button',{name:'Close Leader',exact:true}).click();
 await expect(member).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toHaveCount(0);
});
