import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';

for (const target of ['main', 'side', 'ask'] as const) {
  test(`${target} accepts a disconnected message and sends once after session recovery`, async ({ page }) => {
    const sent: string[] = [];
    page.on('websocket', socket => socket.on('framesent', ({ payload }) => {
      const envelope = JSON.parse(String(payload));
      const message = envelope.type === 'message' ? envelope.message : envelope;
      if (message?.type === 'send_message') sent.push(JSON.stringify(message));
    }));
    await page.goto('/');
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    const primary = page.locator('.lab-primary-conversation');
    await expect(primary.getByTestId('prompt-input')).toBeEnabled();
    if (target !== 'main') {
      await primary.getByTestId('prompt-input').fill(`/${target}`);
      await primary.getByTestId('prompt-input').press('Enter');
      if (target === 'ask') await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
    }
    const pane = target === 'main' ? primary : target === 'side'
      ? page.getByRole('complementary', { name: 'Side conversation' })
      : page.getByRole('dialog', { name: 'Ask', exact: true });
    const text = `Pending ${target} message after mobile sleep`;
    const input = pane.getByTestId('prompt-input');
    await input.fill(text);
    await expect(pane.getByTestId('prompt-submit')).toBeEnabled();
    // Resume the real shared transport while the mobile network is unavailable.
    await page.context().setOffline(true);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await expect(pane.locator('button[aria-label="Open chat commands"]')).toBeDisabled();
    await expect(pane.getByTestId('prompt-submit')).toBeEnabled();
    await pane.getByTestId('prompt-submit').click();
    await expect(pane.getByTestId('pending-send')).toContainText('Waiting to send');
    expect(sent.filter(message => message.includes(text))).toHaveLength(0);
    await expect(input).toHaveValue(text);
    await page.context().setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(pane.getByTestId('pending-send')).toHaveCount(0);
    await expect(pane.locator('.agent-message-assistant').last()).toContainText(text);
    await expect(input).toHaveValue('');
    expect(sent.filter(message => message.includes(text))).toHaveLength(1);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await input.fill('Next draft');
    await expect(pane.getByTestId('prompt-submit')).toBeEnabled();
    expect(sent.filter(message => message.includes(text))).toHaveLength(1);
  });
}
