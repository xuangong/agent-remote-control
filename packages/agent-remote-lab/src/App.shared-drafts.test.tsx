import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { botGroup, botTarget, mountBotApp, seedGroup, until } from './test/bot-mode-fixtures.js';
import { setPromptText } from './test/setup.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

const ref = (id: string) => { const { title: _title, ...session } = botTarget(id); return session; };

it("shares a bot's draft across devices: saved while typing, taken when idle, cleared once sent", async () => {
  const scope = 'http://localhost/u/bot-shared-drafts/';
  seedGroup(scope, botGroup('A')); history.replaceState(null, '', '/?window=A');
  const app = await mountBotApp(scope, { hosted: true });
  const input = () => app.container.querySelector<HTMLElement>('.lab-bot-conversation [role="textbox"]')!;
  const type = async (text: string) => { await act(async () => { setPromptText(input(), text); input().dispatchEvent(new Event('input', { bubbles: true })); }); };
  try {
    await until(() => expect(app.workspace().window?.id).toBe('A'));
    await app.switchMode('bot');
    await act(async () => app.emitDrafts({ snapshot: true, drafts: [{ ...ref('A1'), text: 'Written on the phone', revision: 5 }] }));
    await act(async () => app.button('A1').click());
    // The phone's draft appears in the empty composer.
    await until(() => expect(input()?.textContent).toBe('Written on the phone'));
    // Typing here is saved for every device shortly after the last keystroke.
    await type('Written on the phone, finished here');
    await until(() => expect(app.savedDrafts).toEqual([{ nativeSessionId: 'A1', text: 'Written on the phone, finished here' }]));
    // A draft from another device does not replace text being typed here.
    await type('Still typing');
    await act(async () => app.emitDrafts({ drafts: [{ ...ref('A1'), text: 'From the tablet', revision: 2000 }] }));
    expect(input().textContent).toBe('Still typing');
    await until(() => expect(app.savedDrafts.at(-1)).toEqual({ nativeSessionId: 'A1', text: 'Still typing' }));
    // Sending clears the draft for every device.
    await act(async () => app.container.querySelector<HTMLButtonElement>('.lab-bot-conversation [data-testid="prompt-submit"]')!.click());
    await until(() => expect(app.sendMessages.map(message => message.text)).toEqual(['Still typing']));
    await until(() => expect(app.savedDrafts.at(-1)).toEqual({ nativeSessionId: 'A1', text: '' }));
    // An idle composer follows a draft started on another device.
    await act(async () => app.emitDrafts({ drafts: [{ ...ref('A1'), text: 'Next idea from the phone', revision: 9000 }] }));
    await until(() => expect(input().textContent).toBe('Next idea from the phone'));
  } finally { await app.close(); }
});
