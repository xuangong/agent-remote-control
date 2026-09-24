import { expect, test } from '@playwright/test';

for (const scenario of [
  { code: 'session_attach_timeout', status: 504, role: 'status', text: 'may still be opening' },
  { code: 'native_history_timeout', status: 503, role: 'alert', text: 'reading session history' },
] as const) {
  test(`explains ${scenario.code} and clears it when the same session opens`, async ({ page }, testInfo) => {
    let attempts = 0;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/v1/remote/attach', async route => {
      if (++attempts > 1) return route.continue();
      await route.fulfill({ status: scenario.status, contentType: 'application/json', body: JSON.stringify({
        code: scenario.code, error: 'Fixture failure', requestId: 'diagnostic-request-1',
      }) });
    });
    await page.goto('/');
    const context = testInfo.project.name === 'chromium-mobile' ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    const session = context.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row').first();
    await session.click();
    const notice = page.locator('.lab-session-notice');
    await expect(notice.getByRole(scenario.role)).toContainText(scenario.text);
    await expect(notice).not.toContainText('Retrying automatically');
    const toast = page.locator('.lab-toast').filter({ hasText: 'Session connection' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(scenario.text);
    await page.screenshot({ path: testInfo.outputPath('notification.png'), fullPage: true });
    await toast.getByRole('button', { name: 'Dismiss notification: Session connection' }).click();
    await expect(toast).toHaveCount(0);
    await notice.getByText('Connection details', { exact: true }).click();
    await expect(notice).toContainText(scenario.code);
    await expect(notice).toContainText('diagnostic-request-1');
    await expect(notice).toContainText(String(scenario.status));
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('connection-details.png'), fullPage: true });
    await session.click();
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    await expect(notice).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
  });
}

test('offers immediate native takeover in the chatbox for a cold session',async({page},testInfo)=>{
  const generation='54f9039d-d511-4a28-a373-8b5b53f63963';
  let attempts=0;
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/v1/remote/attach',async route=>{
    const body=route.request().postDataJSON();
    if(++attempts===1){await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'native_session_owned',error:'The native CLI has control.',nativeOwner:{kind:'native_cli',generation}})});return;}
    expect(body.takeOver).toBe(generation);await route.continue();
  });
  await page.goto('/');
  const context=testInfo.project.name==='chromium-mobile'?page.getByRole('dialog',{name:'Context'}):page.locator('#lab-context');
  await context.getByRole('region',{name:'Discover sessions'}).locator('.lab-session-row').first().click();
  const composer=page.getByRole('region',{name:'Live provider controls'});
  await expect(composer).toBeVisible();await expect(composer.locator('[data-testid="prompt-input"]')).toBeHidden();
  await expect(composer).toContainText('interrupts its running work');
  await expect(composer.getByRole('button',{name:'Interrupt and take control',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('native-cli-takeover.png'),fullPage:true});
  await composer.getByRole('button',{name:'Interrupt and take control',exact:true}).click();
  await expect(composer.getByRole('textbox',{name:'Message',exact:true})).toBeEditable();
  await expect(page.locator('.lab-session-control')).toHaveCount(0);
  expect(attempts).toBe(2);expect(errors).toEqual([]);
});

test('checks an unconfirmed native takeover before allowing another interruption', async ({page}, testInfo) => {
  const generation = '54f9039d-d511-4a28-a373-8b5b53f63963';
  let attempts = 0;
  await page.route('**/v1/remote/attach', async route => {
    const body = route.request().postDataJSON();
    attempts++;
    if (attempts === 1) return route.fulfill({status:409, contentType:'application/json', body:JSON.stringify({code:'native_session_owned', error:'CLI has control.', nativeOwner:{kind:'native_cli', generation}})});
    if (attempts === 2) {
      expect(body.takeOver).toBe(generation);
      return route.fulfill({status:409, contentType:'application/json', body:JSON.stringify({code:'native_handoff_unknown', error:'Release was not confirmed.'})});
    }
    expect(body.takeOver).toBeUndefined();
    await route.continue();
  });
  await page.goto('/');
  const context = testInfo.project.name === 'chromium-mobile' ? page.getByRole('dialog', {name:'Context'}) : page.locator('#lab-context');
  await context.getByRole('region', {name:'Discover sessions'}).locator('.lab-session-row').first().click();
  const composer = page.getByRole('region', {name:'Live provider controls'});
  await composer.getByRole('button', {name:'Interrupt and take control', exact:true}).click();
  await expect(composer.getByRole('alert')).toContainText('not confirmed');
  await expect(composer.getByRole('button', {name:'Check session status', exact:true})).toBeEnabled();
  await expect(page.getByRole('button', {name:'Cancel', exact:true})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('unconfirmed-takeover.png'), fullPage:true});
  await composer.getByRole('button', {name:'Check session status', exact:true}).click();
  await expect(composer.getByRole('textbox', {name:'Message', exact:true})).toBeEditable();
  expect(attempts).toBe(3);
});
