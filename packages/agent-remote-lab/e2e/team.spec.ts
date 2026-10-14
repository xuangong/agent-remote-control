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
test('compact Team navigation opens a member with its own editable permissions and returns to the Leader', async ({ page, isMobile }, info) => {
 test.skip(!isMobile, 'Compact Team navigation replaces the single visible session.');
 const { activateComposerAction } = await import('./composer-actions');
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

test('Team applies an ordinary layout and its menu visibility does not hide sessions',async({page,isMobile})=>{
 const subscriptions:string[]=[];
 page.on('websocket',socket=>socket.on('framesent',event=>{
  const frame=JSON.parse(String(event.payload));
  const message=frame.type==='message'?frame.message:frame;
  if(message.type==='timeline_subscription')subscriptions.push(...message.payload.agentIds);
 }));
 const {showNewSession}=await import('./session-navigation');
 await page.goto('/');await showNewSession(page);await page.getByTestId('session-create').click();
 const primary=page.locator('.lab-primary-conversation > .lab-session-view');
 await expect(primary.getByTestId('prompt-input')).toBeEnabled();
 await expect(page).toHaveURL(/[?&]provider=[^&]+/);
 const url=new URL(page.url()),provider=url.searchParams.get('provider')!;
 const [source,leader,member]=await page.evaluate(async providerId=>{
  const create=async()=>{const response=await fetch('/v1/remote/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerId,operationId:crypto.randomUUID()})});
   if(!response.ok)throw new Error(await response.text());return await response.json() as {nativeSessionId:string};};
  return [await create(),await create(),await create()];
 },provider);
 const actual={...team,source:{hostId:'local',providerId:provider,nativeSessionId:source.nativeSessionId,title:'Team main'},members:[
  {...team.members[0],hostId:'local',providerId:provider,nativeSessionId:leader.nativeSessionId},
  {...team.members[1],hostId:'local',providerId:provider,nativeSessionId:member.nativeSessionId},
 ]};
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[actual]}}));
 await page.getByRole('button',{name:'Teams',exact:true}).click();await page.getByRole('button',{name:/Diagnose across Hosts/}).click();
 await expect(primary).toBeVisible();
 await expect.poll(()=>new URL(page.url()).searchParams.get('session')).toBe(isMobile?leader.nativeSessionId:source.nativeSessionId);
 const leaderInput=isMobile?primary.getByTestId('prompt-input'):page.getByRole('region',{name:'Docked Leader',exact:true}).getByTestId('prompt-input');
 await expect(leaderInput).toBeEnabled();await leaderInput.fill('Keep Leader draft');
 if(isMobile){
  const leaderAgent=new URL(page.url()).searchParams.get('agent')!;
  const initialSubscriptions=subscriptions.filter(id=>id===leaderAgent).length;
  expect(initialSubscriptions).toBeGreaterThan(0);
  const entry=page.getByRole('button',{name:'Teams',exact:true}), navigation=page.getByRole('navigation',{name:'Diagnose across Hosts sessions',exact:true});
  await entry.click();await navigation.getByRole('button',{name:/^Windows validation/}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('session')).toBe(member.nativeSessionId);
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await entry.click();await expect(navigation.getByRole('button',{name:/^Windows validation/})).toHaveAttribute('aria-current','page');
  await navigation.getByRole('button',{name:/^Leader/}).click();
  await expect.poll(()=>new URL(page.url()).searchParams.get('session')).toBe(leader.nativeSessionId);
  await expect(leaderInput).toContainText('Keep Leader draft');
  expect(subscriptions.filter(id=>id===leaderAgent)).toHaveLength(initialSubscriptions);
 }
 await openView(page);await page.getByRole('checkbox',{name:'Team view',exact:true}).uncheck();
 await expect(page.getByRole('button',{name:'Teams',exact:true})).toBeHidden();
 await expect(leaderInput).toBeVisible();await expect(leaderInput).toContainText('Keep Leader draft');
 if(!isMobile){
  await expect(page.getByRole('button',{name:'Exit Team mode'})).toHaveCount(0);
  await leaderInput.click();await page.getByRole('button',{name:'Float Leader',exact:true}).click();
  await expect(page.getByRole('region',{name:'Docked Leader',exact:true})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'Leader',exact:true}).getByTestId('prompt-input')).toContainText('Keep Leader draft');
  await page.getByRole('button',{name:'Dock Leader',exact:true}).click();
  await expect(leaderInput).toBeVisible();
 }
 await page.reload();await expect(leaderInput).toBeVisible();
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
  await pane('leader-child').getByRole('button', { name: 'Back to Leader', exact: true }).click();
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

test('Dock child navigation uses the live channel without replacing the main session', async ({ page, isMobile }) => {
 test.skip(isMobile, 'Mobile uses the ordinary primary session navigation covered by the layout test.');
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
 await page.getByRole('button', { name: 'Close Leader',exact:true }).click();
 await expect(primary.getByTestId('prompt-input')).toContainText('Keep primary draft');
 await expect(page).toHaveURL(address);
});

test('Team management adds members in a modal and preserves drafts after rejection', async ({ page }) => {
 const actions: any[] = [];
 let fail = true;
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
 await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Linux investigator');
 await dialog.getByRole('textbox',{name:'Working directory',exact:true}).fill('/work/project');
 await dialog.getByRole('button',{name:'Add member',exact:true}).click();
 await expect(dialog.getByRole('alert')).toBeVisible();
 await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Linux investigator');
 fail=false;await dialog.getByRole('button',{name:'Add member',exact:true}).click();
 await expect(dialog).toHaveCount(0);expect(actions).toHaveLength(2);expect(actions[0]).toEqual(actions[1]);
 await expect(panel).toBeVisible();await expect(page.locator('.lab-session-dock-pane')).toHaveCount(0);
 await panel.getByRole('button',{name:'Archive',exact:true}).click();
 expect(actions.at(-1)).toEqual({teamId:'team',action:'archive'});
});

test('Applying another Team keeps existing docks and repeated opens do not duplicate sessions', async ({ page, isMobile }) => {
 test.skip(isMobile, 'Independent docks require a wide workspace.');
 const other={...team,id:'other-team',title:'Other Team',source:{...team.source,nativeSessionId:'other-source',title:'Other project'},members:[{...team.members[0],id:'other-leader',nativeSessionId:'other-leader',name:'Other leader'}]};
 await page.route('**/v1/remote/teams',route=>route.fulfill({json:{teams:[team,other]}}));
 await page.goto('/e2e/fixtures/team.html?children');
 const open=async(title:string)=>{await page.getByRole('button',{name:'Teams',exact:true}).click();await page.locator('.lab-session-row').filter({hasText:title}).click();};
 await open(team.title);
 const leader=page.getByRole('region',{name:'Leader',exact:true});
 await leader.getByTestId('prompt-input').fill('Keep across Team opens');
 await leader.locator('.agent-child-sessions > summary').click();await leader.locator('[data-child-session-id="leader-child"]').click();
 await expect(page.getByRole('region',{name:'leader-child',exact:true})).toBeVisible();
 await open(other.title);
 await expect(page.getByRole('region',{name:'Other project',exact:true})).toBeVisible();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(3);
 await expect(leader.getByTestId('prompt-input')).toContainText('Keep across Team opens');
 await expect(page.getByRole('region',{name:'leader-child',exact:true})).toBeVisible();
 await leader.getByRole('button',{name:'Move Leader',exact:true}).focus();await page.keyboard.press('ArrowRight');
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
 await member.locator('.agent-child-sessions > summary').click();
 await member.locator('[data-child-session-id="member-child"]').click();
 await expect(page.getByRole('region',{name:'member-child',exact:true})).toBeVisible();
 // The close group survives reload and floating a member out of the rail.
 await page.reload();
 await page.getByRole('button',{name:'Float Windows validation',exact:true}).click();
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
 await member.getByRole('button',{name:'Float Windows validation',exact:true}).click();
 await page.reload();
 await expect(member.getByRole('button',{name:'Dock Windows validation',exact:true})).toBeVisible();
 roster={...roster,members:[...roster.members,{...roster.members[1]!,id:'linux',nativeSessionId:'linux-member',name:'Linux validation'}]};
 fail=true;
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(leader.getByRole('alert')).toContainText('Team catalog is temporarily unavailable.');
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toHaveCount(0);
 fail=false;
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toBeVisible();
 await expect(member.getByRole('button',{name:'Dock Windows validation',exact:true})).toBeVisible();
 await expect(member.getByTestId('prompt-input')).toContainText('Keep member draft');
 await expect(page.getByRole('region',{name:'Project',exact:true})).toBeVisible();
 await leader.getByRole('button',{name:'Gather team members',exact:true}).click();
 await expect(page.locator('.lab-session-dock-pane')).toHaveCount(2);
 await leader.getByRole('button',{name:'Close Leader',exact:true}).click();
 await expect(member).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Linux validation',exact:true})).toHaveCount(0);
});
