import { expect, test } from '@playwright/test';
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
 await expect(page.getByTestId('prompt-input').first()).toBeVisible();
 if(isMobile){expect(attaches).toEqual(['leader']);await expect(page.locator('.lab-team-select select')).toHaveValue('leader');
  await page.getByTestId('prompt-input').fill('Retain my Leader draft');await page.locator('.lab-team-select select').selectOption('member');await expect(page.getByTestId('prompt-input')).toBeVisible();
  await page.locator('.lab-team-select select').selectOption('leader');await expect(page.getByTestId('prompt-input')).toContainText('Retain my Leader draft');
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
 await page.getByRole('button',{name:'Exit Team mode'}).click();await expect(primary).toBeVisible();
 await expect(primary.getByTestId('prompt-input')).toContainText('Keep the ordinary workspace draft');
});
