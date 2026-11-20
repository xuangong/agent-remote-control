// This device's display choices: the appearance, the language and motion. Bound once, before the first render (main.tsx), or by the
// first page that needs them (a fixture page that mounts the App); Settings > General changes them, the palette the appearance too.
import { bindAppearance, bindLanguage, bindMotion, type AppearanceBinding, type LanguageBinding, type MotionBinding } from '@orchardworks/agent-client-web/browser';

export interface DeviceChoices { readonly appearance: AppearanceBinding; readonly language: LanguageBinding; readonly motion: MotionBinding }
let choices: DeviceChoices | undefined;

/** Shows the stored choices; later calls return the same bindings. */
export function deviceChoices(): DeviceChoices {
  choices ??= { appearance: bindAppearance(document, localStorage, window), language: bindLanguage(document, localStorage, window), motion: bindMotion(document, localStorage, window) };
  return choices;
}

/** The appearance binding once the page started it; tests and fixture pages may run without one. */
export function currentAppearance(): AppearanceBinding | undefined {
  return choices?.appearance;
}
