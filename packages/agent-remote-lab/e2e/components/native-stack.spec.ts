// Component projects: webkit-desktop, orchard-phone-webkit
import { expect, test, type Page } from '@playwright/test';

// Navigation as a native stack does it (native-experience audit, step 3): the views under the one on screen keep their place, each
// conversation opens again at the message the reader was on, the phone's push and pop move both layers, and an edge swipe follows the
// finger and can be cancelled. Bot mode over the real Workbench on builder data (four chats of long conversations).
const url = '/e2e/fixtures/window-tiles.html?tiles=4&bots=1&mode=bot&users=4';

async function chats(page: Page) {
  const phone = (page.viewportSize()?.width ?? 1440) <= 760;
  const bot = page.locator('[data-workbench-mode="bot"]');
  const scroller = bot.locator('.lab-timeline-scroll:visible');
  const open = async (index: number) => {
    if (phone && await scroller.count()) await bot.getByRole('button', { name: 'Back to chats' }).first().click();
    await bot.locator('[data-bot-place]').nth(index).click();
    await expect(scroller).toHaveCount(1);
    await expect(scroller.locator('[data-entry-key]').first()).toBeVisible();
  };
  /** The row at the top of the conversation and its distance from the top: the place the reader sees. */
  const place = () => scroller.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll<HTMLElement>('[data-entry-key]')].find(item => item.getBoundingClientRect().bottom > top + 1);
    return { key: row?.dataset.entryKey, offset: Math.round((row?.getBoundingClientRect().top ?? 0) - top), latest: Math.abs(node.scrollTop) < 2 };
  });
  /** The reader scrolls toward older messages: a wheel turn and the scroll it makes (a phone has no wheel). */
  const readBack = (distance: number) => scroller.evaluate((node, distance) => {
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -distance, bubbles: true, cancelable: true }));
    node.scrollBy({ top: -distance, behavior: 'instant' });
  }, distance);
  /** Whether the reader is at `seen` again: the same row at the top, within the 2 px device pixels round to. */
  const at = async (seen: { key?: string; offset: number; latest: boolean }) => {
    const now = await place();
    return now.key === seen.key && now.latest === seen.latest && Math.abs(now.offset - seen.offset) <= 2;
  };
  const reading = async () => {
    await readBack(1100);
    await expect.poll(async () => (await place()).latest).toBe(false);
    return place();
  };
  return { phone, bot, scroller, open, place, at, reading };
}

test('back from the details and from another chat, the reader is on the same message at the same offset', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const { phone, bot, scroller, open, at, reading } = await chats(page);
  await open(0);
  const seen = await reading();
  // The details open beside the conversation (already open on a wide screen) or over it as a sheet on a phone, and close again.
  const title = bot.locator('button.lab-assistant-title');
  if (phone) {
    await title.click();
    await expect(page.locator('dialog.orchard-sheet[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.orchard-sheet[open]')).toHaveCount(0);
  } else {
    await expect(bot.locator('.lab-assistant-details')).toBeVisible();
    await title.click();
    await expect(bot.locator('.lab-assistant-details')).toBeHidden();
    await title.click();
    await expect(bot.locator('.lab-assistant-details')).toBeVisible();
  }
  await expect.poll(() => at(seen)).toBe(true);
  // To the list and into the same chat again; into another chat and back.
  await open(1);
  await open(0);
  await expect.poll(() => at(seen)).toBe(true);
  if (phone) await expect(scroller).toHaveCount(1);
});

test('the chats under the one on screen stay mounted, up to three, and a chat released from them opens at its stored place', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const { bot, open, at, reading } = await chats(page);
  await open(0);
  const seen = await reading();
  // The conversation the reader left is the same view when they return to it, not one built again: the view under it is kept mounted.
  const mark = (name: string) => bot.locator('.lab-timeline-scroll:visible').evaluate((node, name) => { (node as unknown as Record<string, string>).__view = name; }, name);
  const marked = () => bot.locator('.lab-timeline-scroll:visible').evaluate(node => (node as unknown as Record<string, string | undefined>).__view);
  await mark('first');
  await open(1);
  await mark('second');
  await open(2);
  await open(1);
  expect(await marked()).toBe('second');
  await open(0);
  expect(await marked()).toBe('first');
  await open(1); await open(2); await open(3);
  // Chat 0 was left by three others: it is released and opens from its stored reading position.
  await open(0);
  expect(await marked()).toBeUndefined();
  await expect.poll(() => at(seen)).toBe(true);
});

test('a reload puts the reader back on the message they were on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const { open, reading } = await chats(page);
  await open(0);
  // Far enough back that the turns above the reader were never rendered (content-visibility) when the page opens again.
  const seen = await reading();
  await page.reload();
  const again = await chats(page);
  if (await again.scroller.count() === 0) await again.open(0);
  await expect.poll(() => again.at(seen)).toBe(true);
});

test('a conversation left at its latest message stays pinned to it while messages arrive', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  const { open, place, scroller } = await chats(page);
  await open(0);
  expect((await place()).latest).toBe(true);
  await open(1); await open(0);
  expect((await place()).latest).toBe(true);
  await scroller.evaluate(node => {
    const content = node.querySelector('.lab-conversation-content')!;
    const row = document.createElement('div'); row.style.height = '300px'; content.append(row);
  });
  await expect.poll(async () => (await place()).latest).toBe(true);
});

/** The conversation's and the list's geometry on every frame, while `action` runs. */
async function frames(page: Page, action: () => Promise<unknown>) {
  await page.evaluate(() => {
    const conversation = document.querySelector<HTMLElement>('.lab-bot-conversation')!, list = document.querySelector<HTMLElement>('.lab-bot-roster')!;
    const scrim = document.querySelector<HTMLElement>('.lab-bot-scrim');
    const seen: { t: number; left: number; listShown: boolean; listLeft: number; scrim: number; conversationShown: boolean }[] = [];
    const w = window as unknown as { __frames: typeof seen; __watching: boolean };
    w.__frames = seen; w.__watching = true;
    const tick = () => {
      seen.push({ t: performance.now(), left: conversation.getBoundingClientRect().left, conversationShown: conversation.getClientRects().length > 0,
        listShown: list.getClientRects().length > 0, listLeft: list.getBoundingClientRect().left, scrim: scrim ? Number(getComputedStyle(scrim).opacity) : 0 });
      if (w.__watching) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await action();
  await page.waitForTimeout(700);
  return page.evaluate(() => { const w = window as unknown as { __frames: { t: number; left: number; listShown: boolean; listLeft: number; scrim: number; conversationShown: boolean }[]; __watching: boolean }; w.__watching = false; return w.__frames; });
}

test.describe('on a phone', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 760, 'A phone width.');

  test('a chat slides over the list and Back slides it away: both layers move, the list shifts and dims', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    const width = page.viewportSize()!.width;
    const pushed = await frames(page, () => bot.locator('[data-bot-place]').first().click());
    // Mid-push: the chat is part way across, and the list is still on screen under it, shifted left and dimmed.
    const midPush = pushed.filter(frame => frame.left > 1 && frame.left < width - 1 && frame.conversationShown);
    expect(midPush.length).toBeGreaterThan(2);
    expect(midPush.every(frame => frame.listShown)).toBe(true);
    expect(midPush.some(frame => frame.listLeft < -1 && frame.listLeft > -width * 0.3 - 1)).toBe(true);
    expect(midPush.some(frame => frame.scrim > 0.01)).toBe(true);
    // At rest the chat is alone: the list is not displayed and nothing is dimmed or shifted.
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    expect(Math.abs(pushed.at(-1)!.left)).toBeLessThan(1);
    const popped = await frames(page, () => bot.getByRole('button', { name: 'Back to chats' }).first().click());
    const midPop = popped.filter(frame => frame.left > 1 && frame.left < width - 1 && frame.conversationShown);
    expect(midPop.length).toBeGreaterThan(2);
    expect(midPop.every(frame => frame.listShown)).toBe(true);
    expect(midPop.some(frame => frame.listLeft < -1)).toBe(true);
    // The chat that slides out still shows its conversation, and it is gone at the end.
    await expect(bot.locator('.lab-bot-conversation')).toBeHidden();
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
    expect(Math.abs((await bot.locator('.lab-bot-roster').boundingBox())!.x)).toBeLessThan(1);
    void open;
  });

  /** A finger on the screen, as pointer events carry it, with a pause on each move so that it has a speed. */
  async function finger(page: Page, steps: { type: 'down' | 'move' | 'up' | 'cancel'; x: number; y?: number }[]) {
    for (const step of steps) {
      await page.evaluate(({ step }) => {
        const options = { pointerId: 41, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: step.x, clientY: step.y ?? 400 };
        const target = step.type === 'down' ? document.querySelector('.lab-bot-edge')! : window;
        target.dispatchEvent(new PointerEvent(step.type === 'down' ? 'pointerdown' : step.type === 'move' ? 'pointermove' : step.type === 'cancel' ? 'pointercancel' : 'pointerup', options));
      }, { step });
      await page.waitForTimeout(120);
    }
  }

  test('an edge swipe drags the chat with the finger over the list, and releasing it short returns the chat', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    const conversation = bot.locator('.lab-bot-conversation'), list = bot.locator('.lab-bot-roster');
    await expect(list).toBeHidden();
    const before = page.url();
    await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 60 }, { type: 'move', x: 160 }]);
    // The chat is where the finger is (it started at 8 px), and the list shows under it, shifted by a share of the distance.
    await expect.poll(async () => Math.round((await conversation.boundingBox())!.x)).toBe(152);
    await expect(list).toBeVisible();
    const shifted = (await list.boundingBox())!.x;
    expect(shifted).toBeLessThan(0); expect(shifted).toBeGreaterThan(-0.3 * 390);
    await finger(page, [{ type: 'move', x: 230 }]);
    await expect.poll(async () => Math.round((await conversation.boundingBox())!.x)).toBe(222);
    // Back to the edge and let go: the chat returns, the list goes, and no history entry was used.
    await finger(page, [{ type: 'move', x: 100 }, { type: 'move', x: 40 }, { type: 'up', x: 40 }]);
    await expect.poll(async () => Math.round((await conversation.boundingBox())!.x)).toBe(0);
    await expect(list).toBeHidden();
    expect(page.url()).toBe(before);
    await expect(bot.locator('.lab-timeline-scroll:visible')).toHaveCount(1);
  });

  test('a real touch from the edge follows the finger: the browser leaves the gesture to the page', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', "Real touch input is Chromium's DevTools input; the other engines are driven by pointer events.");
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: string, x: number, y: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] } as never);
    // Over the conversation's text, where a vertical drag scrolls and a horizontal one has nothing to scroll.
    await touch('touchStart', 6, 400);
    for (const x of [40, 90, 160, 210]) { await touch('touchMove', x, 405); await page.waitForTimeout(80); }
    await expect.poll(async () => Math.round((await bot.locator('.lab-bot-conversation').boundingBox())!.x)).toBeGreaterThan(150);
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
    // Back toward the edge and up: the chat returns.
    for (const x of [120, 50]) { await touch('touchMove', x, 405); await page.waitForTimeout(100); }
    await touch('touchEnd', 0, 0);
    await expect.poll(async () => Math.round((await bot.locator('.lab-bot-conversation').boundingBox())!.x)).toBe(0);
  });

  test('releasing the edge swipe past the middle goes back to the list', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 80 }, { type: 'move', x: 200 }, { type: 'move', x: 300 }, { type: 'up', x: 300 }]);
    await expect(bot.locator('.lab-bot-conversation')).toBeHidden();
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
    expect(Math.abs((await bot.locator('.lab-bot-roster').boundingBox())!.x)).toBeLessThan(1);
    // The same history entry the Back button pops: the list is home and nothing is left half-way.
    await expect(bot.locator('.lab-bot-scrim')).toHaveCSS('opacity', '0');
  });

  type Frame = Awaited<ReturnType<typeof frames>>[number];
  /** From the end of a drag to rest the chat only moves away, the list only settles in, and the dimming only fades: nothing reverses, resets or flashes. */
  function expectOneWay(seen: Frame[], width: number) {
    const shown = seen.filter(frame => frame.conversationShown);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]!.left, `chat at frame ${i}`).toBeGreaterThanOrEqual(shown[i - 1]!.left - 0.5);
      expect(shown[i]!.listLeft, `list at frame ${i}`).toBeGreaterThanOrEqual(shown[i - 1]!.listLeft - 0.5);
      expect(shown[i]!.scrim, `dimming at frame ${i}`).toBeLessThanOrEqual(shown[i - 1]!.scrim + 0.01);
      if (shown[i]!.left > 1) expect(shown[i]!.listShown, `list shown at frame ${i}`).toBe(true);
    }
    expect(shown.at(-1)!.left).toBeGreaterThanOrEqual(0);
    void width;
  }

  test('releasing the swipe past the middle carries on to the list in one movement, with a popstate before, during or after it', async ({ page }) => {
    for (const delay of [0, 100, 450]) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(url);
      const { bot, open } = await chats(page);
      await open(0);
      await expect(bot.locator('.lab-bot-roster')).toBeHidden();
      await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 80 }, { type: 'move', x: 200 }, { type: 'move', x: 280 }]);
      const seen = await frames(page, async () => {
        await finger(page, [{ type: 'up', x: 280 }]);
        // The page's own history goes back, as the app does after a swipe, and as a system back would.
        await page.waitForTimeout(delay);
      });
      await expect(bot.locator('.lab-bot-conversation')).toBeHidden();
      expectOneWay(seen, page.viewportSize()!.width);
    }
  });

  test('a swipe the system cancels part-way, and the back it makes, never bring the chat back across the screen', async ({ page }) => {
    for (const delay of [0, 150, 400]) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(url);
      const { bot, open } = await chats(page);
      await open(0);
      await expect(bot.locator('.lab-bot-roster')).toBeHidden();
      await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 80 }, { type: 'move', x: 150 }]);
      const seen = await frames(page, async () => {
        await finger(page, [{ type: 'cancel', x: 150 }]);
        await page.waitForTimeout(delay);
        await page.evaluate(() => history.back());
      });
      await expect(bot.locator('.lab-bot-conversation')).toBeHidden();
      expectOneWay(seen, page.viewportSize()!.width);
    }
  });

  test('a swipe the system cancels with no back after it returns the chat once the system has had its time', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 80 }, { type: 'move', x: 150 }, { type: 'cancel', x: 150 }]);
    await expect.poll(async () => Math.round((await bot.locator('.lab-bot-conversation').boundingBox())!.x), { timeout: 4000 }).toBe(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
  });

  /** The page as iOS runs it from the home screen: it has its own swipe back from the left edge for the page's history. */
  async function installedOnIos(page: Page) {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
  }

  test('where the platform swipes back itself the page draws no swipe, and its back swaps to the list at once, with nothing slid', async ({ page }) => {
    await installedOnIos(page);
    const { bot, open } = await chats(page);
    await open(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    await expect(bot.locator('.lab-bot-edge')).toHaveCount(0);
    const before = await bot.locator('.lab-timeline-scroll:visible').count();
    expect(before).toBe(1);
    const seen = await frames(page, async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __popAt?: number };
        addEventListener('popstate', () => { w.__popAt = performance.now(); }, { once: true });
        const touch = (type: string, x: number) => { const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 400, identifier: 1 }] }); document.body.dispatchEvent(event); };
        touch('touchstart', 5); touch('touchmove', 120); touch('touchmove', 260); touch('touchend', 260);
        // The system's swipe back goes back in the history, with nothing of the page's own in between.
        history.back();
      });
    });
    const popAt = await page.evaluate(() => (window as unknown as { __popAt?: number }).__popAt!);
    const after = seen.filter(frame => frame.t >= popAt);
    expect(after.length).toBeGreaterThan(5);
    for (const frame of after) {
      expect(frame.conversationShown).toBe(false);
      expect(frame.listShown).toBe(true);
      expect(Math.abs(frame.listLeft)).toBeLessThan(0.5);
      expect(frame.scrim).toBe(0);
    }
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });

  test('where the platform swipes back itself, the Back button still slides the chat away', async ({ page }) => {
    await installedOnIos(page);
    const { bot, open } = await chats(page);
    await open(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    const width = page.viewportSize()!.width;
    const seen = await frames(page, () => bot.getByRole('button', { name: 'Back to chats' }).first().click());
    expect(seen.filter(frame => frame.conversationShown && frame.left > 1 && frame.left < width - 1).length).toBeGreaterThan(2);
  });

  test('a touch the system takes over, and the back it makes, are the system\'s: the stack slides nothing of its own', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    await expect(bot.locator('.lab-bot-roster')).toBeHidden();
    const width = page.viewportSize()!.width;
    const seen = await frames(page, async () => {
      await page.evaluate(() => {
        const options = (x: number) => ({ pointerId: 51, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: 400 });
        document.querySelector('.lab-bot-edge')!.dispatchEvent(new PointerEvent('pointerdown', options(6)));
        window.dispatchEvent(new PointerEvent('pointercancel', options(6)));
        history.back();
      });
    });
    await expect(bot.locator('.lab-bot-conversation')).toBeHidden();
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
    expect(seen.filter(frame => frame.conversationShown && frame.left > 1 && frame.left < width - 1)).toEqual([]);
  });

  test('a finger that starts away from the edge, or goes down the screen, leaves the chat alone', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    const conversation = bot.locator('.lab-bot-conversation');
    await finger(page, [{ type: 'down', x: 120 }, { type: 'move', x: 220 }, { type: 'move', x: 300 }, { type: 'up', x: 300 }]);
    expect(Math.round((await conversation.boundingBox())!.x)).toBe(0);
    await finger(page, [{ type: 'down', x: 8 }, { type: 'move', x: 12, y: 460 }, { type: 'move', x: 200, y: 560 }, { type: 'up', x: 200, y: 560 }]);
    expect(Math.round((await conversation.boundingBox())!.x)).toBe(0);
    await expect(conversation).toBeVisible();
  });

  test('with reduced motion Back and a push settle at once and nothing is left animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(url);
    const { bot } = await chats(page);
    const pushed = await frames(page, () => bot.locator('[data-bot-place]').first().click());
    expect(pushed.filter(frame => frame.left > 1 && frame.conversationShown && frame.listShown)).toEqual([]);
    const popped = await frames(page, () => bot.getByRole('button', { name: 'Back to chats' }).first().click());
    expect(popped.filter(frame => frame.left > 1 && frame.conversationShown)).toEqual([]);
    expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
    await expect(bot.locator('.lab-bot-roster')).toBeVisible();
  });
});

test.describe('on a wide screen', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) <= 760, 'A wide screen.');

  test('choosing another chat moves nothing: no slide, no dimming, and the list stays', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(url);
    const { bot, open } = await chats(page);
    await open(0);
    const seen = await frames(page, () => open(1));
    const lefts = new Set(seen.filter(frame => frame.conversationShown).map(frame => Math.round(frame.left)));
    expect(lefts.size).toBe(1);
    expect(seen.every(frame => frame.listShown && frame.scrim === 0)).toBe(true);
    await expect(bot.locator('.lab-bot-scrim')).toHaveCount(0);
  });
});
