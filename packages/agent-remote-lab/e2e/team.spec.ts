import { expect, test, type Page } from '@playwright/test';
async function openView(page: Page) {
 const trigger = page.getByRole('button', { name: 'View options', exact: true });
 if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click();
}
const team={id:'team',operationId:'create',revision:1,title:'Diagnose across Hosts',status:'active',source:{hostId:'mac',providerId:'codex',nativeSessionId:'source',title:'Project'},createdAt:1,updatedAt:1,messages:[],members:[
 {id:'leader',name:'Leader',role:'leader',hostId:'mac',providerId:'codex',nativeSessionId:'leader',creation:'ready',activity:'idle',responsibility:'Discuss and implement',summary:'',updatedAt:1},
 {id:'member',name:'Windows validation',role:'member',hostId:'win',providerId:'codex',nativeSessionId:'member',creation:'ready',activity:'idle',responsibility:'Check service logs',summary:'',updatedAt:1},
]};
test.beforeEach(async({page})=>{
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[team]}}));
 await page.route('**/v1/remote/hosts/*/attach',route=>route.fulfill({json:{agentId:route.request().postDataJSON().nativeSessionId}}));
});
test('Team entry keeps standard chat controls, desktop pane resizing and mobile Leader-first navigation',async({page,isMobile},info)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const attaches:string[]=[];page.on('request',request=>{if(request.url().endsWith('/attach'))attaches.push(request.postDataJSON().nativeSessionId);});
 await page.goto('/e2e/fixtures/team.html');await page.getByRole('button',{name:'Teams',exact:true}).click();
 await page.getByRole('button',{name:/Diagnose across Hosts/}).click();
 const panes=page.locator('.lab-team-pane:visible');await expect(panes).toHaveCount(isMobile?1:3);
 await expect(page.locator('[data-testid="prompt-input"]:visible').first()).toBeVisible();
 if(isMobile){expect(attaches).toEqual(['leader']);await expect(page.locator('.lab-team-select select')).toHaveValue('leader');
  await page.locator('[data-testid="prompt-input"]:visible').fill('Retain my Leader draft');await page.locator('.lab-team-select select').selectOption('member');await expect(page.locator('[data-testid="prompt-input"]:visible')).toBeVisible();
  await page.locator('.lab-team-select select').selectOption('leader');await expect(page.locator('[data-testid="prompt-input"]:visible')).toContainText('Retain my Leader draft');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }else{expect(attaches).toEqual(['source','leader','member']);const pane=page.getByRole('region',{name:'Leader',exact:true}),before=(await pane.boundingBox())!;
  const handle=page.getByRole('separator',{name:'Resize Leader',exact:true});await handle.focus();await page.keyboard.press('ArrowRight');await expect.poll(async()=>(await pane.boundingBox())!.width).toBeGreaterThan(before.width);
  expect(await page.locator('.lab-team-rail').evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
 }
 await page.screenshot({path:info.outputPath('team.png')});
 await page.reload();await expect(page.locator('.lab-team-workspace')).toBeVisible();
 if(isMobile)await expect(page.locator('.lab-team-select select')).toHaveValue('leader');
 await page.getByRole('button',{name:'Exit Team mode'}).click();await expect(page.getByText('Ordinary workspace')).toBeVisible();expect(errors).toEqual([]);
});

test('Team mode mounts in the product shell and restores the ordinary session draft on exit',async({page,isMobile})=>{
 const {showNewSession}=await import('./session-navigation');
 await page.goto('/');await showNewSession(page);await page.getByTestId('session-create').click();
 const primary=page.locator('.lab-primary-conversation > .lab-session-view');
 await expect(primary.getByTestId('prompt-input')).toBeEnabled();
 await primary.getByTestId('prompt-input').fill('Keep the ordinary workspace draft');
 const url=new URL(page.url()),provider=url.searchParams.get('provider')!,nativeSessionId=url.searchParams.get('session')!;
 const leader=await page.evaluate(async providerId=>{
  const response=await fetch('/v1/remote/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerId,operationId:crypto.randomUUID()})});
  if(!response.ok)throw new Error(await response.text());return await response.json() as {nativeSessionId:string};
 },provider);
 const actual={...team,source:{hostId:'local',providerId:provider,nativeSessionId,title:'Retained main'},members:[{...team.members[0],hostId:'local',providerId:provider,nativeSessionId:leader.nativeSessionId}]};
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[actual]}}));
 await page.getByRole('button',{name:'Teams',exact:true}).click();await page.getByRole('button',{name:/Diagnose across Hosts/}).click();
 await expect(primary).toBeHidden();await expect(page.locator('.lab-team-workspace')).toBeVisible();
 await expect(page.locator('.lab-team-pane:visible')).toHaveCount(isMobile?1:2);
 await expect(page.locator('.lab-team-workspace').getByTestId('prompt-input').first()).toBeEnabled();
 const leaderInput = page.getByRole('region', { name: 'Leader', exact: true }).getByTestId('prompt-input');
 await leaderInput.fill('Keep the Leader draft while hidden');
 await openView(page);
 await page.getByRole('checkbox', { name: 'Team view', exact: true }).uncheck();
 await expect(primary).toBeVisible(); await expect(page.locator('.lab-team-workspace')).toBeHidden();
 await expect(primary.getByTestId('prompt-input')).toContainText('Keep the ordinary workspace draft');
 await openView(page);
 await page.getByRole('checkbox', { name: 'Team view', exact: true }).check();
 await expect(leaderInput).toBeVisible(); await expect(leaderInput).toContainText('Keep the Leader draft while hidden');
 await leaderInput.fill('/team off'); await leaderInput.press('Enter'); await expect(primary).toBeVisible();
 await openView(page);
 await page.getByRole('checkbox', { name: 'Team view', exact: true }).check();
 await expect(page.locator('.lab-team-workspace')).toBeVisible();
 await page.getByRole('button',{name:'Exit Team mode'}).click();await expect(primary).toBeVisible();
 await expect(primary.getByTestId('prompt-input')).toContainText('Keep the ordinary workspace draft');
});

test('Team command and View switch share a retained presentation preference', async ({ page }) => {
 const { showNewSession } = await import('./session-navigation');
 await page.goto('/'); await showNewSession(page); await page.getByTestId('session-create').click();
 const primary = page.locator('.lab-primary-conversation > .lab-session-view');
 const input = primary.getByTestId('prompt-input');
 await expect(input).toBeEnabled();
 const entry = page.getByRole('button', { name: 'Teams', exact: true });
 await expect(entry).toBeVisible();
 await input.fill('/team off'); await input.press('Enter'); await expect(entry).toBeHidden();
 await openView(page);
 const toggle = page.getByRole('checkbox', { name: 'Team view', exact: true });
 await expect(toggle).not.toBeChecked(); await toggle.check(); await expect(entry).toBeVisible();
 await input.click(); await input.fill('/team'); await input.press('Enter'); await expect(entry).toBeHidden();
 await page.reload(); await expect(input).toBeEnabled(); await expect(entry).toBeHidden();
 await input.fill('/team on'); await input.press('Enter'); await expect(entry).toBeVisible();
 await openView(page); await expect(toggle).toBeChecked();
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
 await expect(page.locator('.lab-team-workspace')).toHaveCount(0);
 await panel.locator('.lab-session-row').click();
 await expect(page.locator('.lab-team-title')).toHaveText('New team');
 await expect(page.locator('.lab-team-heading').getByRole('button', { name: 'New team', exact: true })).toHaveCount(0);
 await entry.click();
 await panel.getByRole('button', { name: 'Rename Team', exact: true }).click();
 const input = panel.getByRole('textbox', { name: 'Team name' });
 await input.fill('  Windows investigation  ');
 await panel.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(input).toHaveCount(0);
 await expect(page.locator('.lab-team-title')).toHaveText('Windows investigation');
 await expect(panel.locator('.lab-session-row')).toContainText('Windows investigation');
 expect(actions).toEqual([{ action: 'rename', teamId: 'team', title: 'Windows investigation' }]);
 await expect(panel.getByRole('button', { name: 'New team', exact: true })).toHaveCount(1);
 fail = true;
 await panel.getByRole('button', { name: 'Rename Team', exact: true }).click();
 await input.fill('Keep this draft');
 await panel.getByRole('button', { name: 'Save', exact: true }).click();
 await expect(panel.getByRole('alert')).toHaveText('Rename unavailable');
 await expect(input).toHaveValue('Keep this draft');
 await expect(page.locator('.lab-team-title')).toHaveText('Windows investigation');
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
 const pane = (name: string) => page.locator('.lab-team-pane').filter({ has: page.locator('.lab-team-pane-heading > strong', { hasText: new RegExp(`^${name}$`) }) });
 const openChild = async (parent: string, child: string) => {
  const list = pane(parent).getByRole('group', { name: 'Session subagents', exact: true });
  await expect(list).toBeVisible();
  if (await list.getAttribute('open') === null) await list.locator('summary').click();
  await pane(parent).locator(`[data-child-session-id="${child}"]`).click();
  await expect(pane(child).getByTestId('prompt-input')).toBeVisible();
  if (!isMobile) await expect.poll(async () => {
   const box = (await pane(child).boundingBox())!;
   return box.x >= -1 && box.x + box.width <= page.viewportSize()!.width + 1;
  }).toBe(true);
 };
 await pane('Leader').getByTestId('prompt-input').fill('Keep Leader draft');
 await openChild('Leader', 'leader-child');
 if (isMobile) {
  await expect(page.locator('.lab-team-pane:visible')).toHaveCount(1);
  await pane('leader-child').getByRole('button', { name: 'Back to Leader', exact: true }).click();
  await expect(pane('Leader').getByTestId('prompt-input')).toContainText('Keep Leader draft');
  await openChild('Leader', 'leader-child');
 } else {
  await expect(page.locator('.lab-team-pane-heading > strong')).toHaveText(['Main · Project', 'Leader', 'leader-child', 'Windows validation']);
  await pane('Leader').getByTestId('prompt-input').click();
  await expect(pane('leader-child')).toBeVisible();
 }
 await openChild('leader-child', 'leader-grandchild');
 if (isMobile) await page.locator('.lab-team-select select').selectOption('member');
 await openChild('Windows validation', 'member-child');
 await page.screenshot({ path: info.outputPath('team-families.png') });
 if (isMobile) {
  await page.locator('.lab-team-select select').selectOption('leader');
  await expect(pane('leader-grandchild')).toBeVisible();
 } else {
  await expect(page.locator('.lab-team-pane-heading > strong')).toHaveText(['Main · Project', 'Leader', 'leader-child', 'leader-grandchild', 'Windows validation', 'member-child']);
  await pane('leader-child').getByRole('button', { name: 'Close subagent', exact: true }).click();
  await expect(pane('leader-child')).toHaveCount(0);
  await expect(pane('leader-grandchild')).toHaveCount(0);
  await expect(pane('member-child')).toBeVisible();
  await expect(pane('Leader').getByTestId('prompt-input')).toContainText('Keep Leader draft');
 }
 expect(requests.map(value => [value.parentNativeSessionId, value.nativeSessionId])).toEqual([
  ['leader', 'leader-child'], ['leader-child', 'leader-grandchild'], ['member', 'member-child'],
 ]);
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 await page.reload();
 await expect(pane(isMobile ? 'leader-grandchild' : 'member-child').getByTestId('prompt-input')).toBeVisible();
 if (!isMobile) await expect(pane('leader-child')).toHaveCount(0);
});

test('Team child navigation uses the live session channel without navigating the hidden main workspace', async ({ page, isMobile }) => {
 const { showNewSession } = await import('./session-navigation');
 let leader: { agentId: string; nativeSessionId: string } | undefined;
 let child: { agentId: string; nativeSessionId: string } | undefined;
 await page.routeWebSocket(/session-channel/, route => {
  const server = route.connectToServer();
  server.onMessage(message => {
   const envelope = JSON.parse(String(message)), frame = envelope.type === 'message' ? envelope.message : envelope;
   if (frame.type === 'agent_snapshot' && child && frame.payload.runtimeInfo.sessionId === leader?.nativeSessionId) {
    frame.payload.runtimeInfo.childSessions = [{ nativeSessionId: child.nativeSessionId, title: 'Live child', createdAt: '2026-10-13T00:00:00Z', status: 'idle', observation: 'live' }];
   }
   route.send(JSON.stringify(envelope));
  });
 });
 await page.goto('/'); await showNewSession(page); await page.getByTestId('session-create').click();
 const primary = page.locator('.lab-primary-conversation > .lab-session-view');
 await expect(primary.getByTestId('prompt-input')).toBeEnabled();
 await primary.getByTestId('prompt-input').fill('Keep primary draft');
 await expect(page).toHaveURL(/[?&]provider=[^&]+/);
 const address = page.url(), url = new URL(address), provider = url.searchParams.get('provider')!, nativeSessionId = url.searchParams.get('session')!;
 [leader, child] = await page.evaluate(async providerId => {
  const create = async () => {
   const response = await fetch('/v1/remote/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId, operationId: crypto.randomUUID() }) });
   if (!response.ok) throw new Error(await response.text());
   return await response.json() as { agentId: string; nativeSessionId: string };
  };
  return [await create(), await create()];
 }, provider);
 const actual = { ...team, source: { hostId: 'local', providerId: provider, nativeSessionId, title: 'Main' }, members: [{ ...team.members[0], hostId: 'local', providerId: provider, nativeSessionId: leader!.nativeSessionId }] };
 await page.route('**/v1/remote/teams', route => route.fulfill({ json: { teams: [actual] } }));
 const requests: unknown[] = [];
 let fail = true;
 await page.route('**/v1/remote/child/attach', route => {
  requests.push(route.request().postDataJSON());
  return fail ? route.fulfill({ status: 503, json: { error: 'Child temporarily unavailable' } }) : route.fulfill({ json: child });
 });
 await page.getByRole('button', { name: 'Teams', exact: true }).click();
 await page.locator('.lab-session-row').filter({ hasText: team.title }).click();
 const parent = page.getByRole('region', { name: 'Leader', exact: true });
 await expect(parent.getByTestId('prompt-input')).toBeEnabled();
 await parent.getByTestId('prompt-input').fill('Keep Team draft');
 await parent.locator('.agent-child-sessions > summary').click();
 await parent.locator(`[data-child-session-id="${child!.nativeSessionId}"]`).click();
 const childPane = page.getByRole('region', { name: 'Live child', exact: true });
 await expect(childPane.getByRole('alert')).toContainText('Child temporarily unavailable');
 await expect(page).toHaveURL(address);
 fail = false;
 const attemptsBeforeRetry = requests.length;
 await childPane.getByRole('button', { name: 'Retry', exact: true }).click();
 await expect(childPane.getByTestId('prompt-input')).toBeEnabled();
 expect(requests).toHaveLength(attemptsBeforeRetry + 1);
 expect(requests).toEqual(Array(requests.length).fill({ providerId: provider, parentNativeSessionId: leader!.nativeSessionId, nativeSessionId: child!.nativeSessionId }));
 await childPane.getByRole('button', { name: isMobile ? 'Back to Leader' : 'Close subagent', exact: true }).click();
 await expect(parent.getByTestId('prompt-input')).toContainText('Keep Team draft');
 await page.getByRole('button', { name: 'Exit Team mode' }).click();
 await expect(primary.getByTestId('prompt-input')).toContainText('Keep primary draft');
 await expect(page).toHaveURL(address);
});
