/**
 * Installing Orchard as an app: what Settings > General offers on this browser. Chromium browsers offer installation through
 * `beforeinstallprompt`, which may fire before any page of ours mounts, so the page keeps the event from its start; Safari offers no
 * event, only its own menu (Add to Home Screen on iPhone and iPad, Add to Dock on a Mac). The rules are pure; the store below is the
 * page's one listener.
 */
import { useSyncExternalStore } from 'react';
import { runsInstalled, type InstalledAppView } from './installed-app.js';

export type InstallPlatform = 'ios' | 'safari-mac' | 'other';
/** What the entry offers: the browser's own prompt, Safari's instructions for the home screen or the Dock, or nothing. */
export type InstallOffer = 'prompt' | 'home-screen' | 'dock' | 'none';

/** The platform by its user agent: iPadOS reports a Mac with touch points; Safari on a Mac adds to the Dock from version 17. */
export function installPlatform(userAgent: string, maxTouchPoints: number): InstallPlatform {
  if (/iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)) return 'ios';
  const safari = /Macintosh/.test(userAgent) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(userAgent) ? /Version\/(\d+)[^ ]* .*Safari\//.exec(userAgent) : null;
  return safari && Number(safari[1]) >= 17 ? 'safari-mac' : 'other';
}

/** The offer: none in the installed app itself; the browser's prompt when it gave one; Safari's instructions; otherwise nothing. */
export function installOffer(facts: { installed: boolean; promptAvailable: boolean; platform: InstallPlatform }): InstallOffer {
  if (facts.installed) return 'none';
  if (facts.promptAvailable) return 'prompt';
  return facts.platform === 'ios' ? 'home-screen' : facts.platform === 'safari-mac' ? 'dock' : 'none';
}

/** The browser's install prompt event (Chromium); not in the DOM types. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: InstallPromptEvent | undefined;
let installedNow = false;
let started = false;
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/**
 * Keeps the browser's install prompt from the page's start, in place of the browser's own banner, so Settings can offer it; forgets it
 * once the app is installed. Call once, before anything renders.
 */
export function keepInstallPrompt(target: Pick<Window, 'addEventListener'> = window): void {
  if (started) return;
  started = true;
  target.addEventListener('beforeinstallprompt', event => { event.preventDefault(); deferred = event as InstallPromptEvent; changed(); });
  target.addEventListener('appinstalled', () => { deferred = undefined; installedNow = true; changed(); });
}

/**
 * Shows the browser's install dialog; resolves whether the person installed, and never rejects. The prompt can be shown once, so it is
 * spent either way.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = undefined; changed();
  try {
    await event.prompt();
    return (await event.userChoice).outcome === 'accepted';
  } catch { return false; }
}

// The page's start keeps the prompt (main.tsx); a surface that reads the offer without it, such as a fixture page, starts it then.
const subscribe = (listener: () => void) => { keepInstallPrompt(); listeners.add(listener); return () => { listeners.delete(listener); }; };

/** What the offer reads of a page besides the installed app's facts. */
export interface InstallView extends InstalledAppView {
  readonly navigator: InstalledAppView['navigator'] & { readonly userAgent: string; readonly maxTouchPoints: number };
}

/** This page's offer, following the prompt as the browser gives or withdraws it. */
export function useInstallOffer(view: InstallView = window as unknown as InstallView): InstallOffer {
  const snapshot = () => installOffer({
    installed: installedNow || runsInstalled(view), promptAvailable: !!deferred,
    platform: installPlatform(view.navigator.userAgent, view.navigator.maxTouchPoints),
  });
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
