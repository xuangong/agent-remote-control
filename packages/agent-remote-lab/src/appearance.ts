// This device's appearance (System, Light or Dark): bound once at startup, before the first render, and changed from the command palette.
import { bindAppearance, type AppearanceBinding } from '@orchardworks/agent-client-web/browser';

let binding: AppearanceBinding | undefined;

/** Shows the stored appearance; later calls return the same binding. */
export function startAppearance(): AppearanceBinding {
  binding ??= bindAppearance(document, localStorage);
  return binding;
}

/** The binding once the page started it; tests and fixture pages may run without one. */
export function currentAppearance(): AppearanceBinding | undefined {
  return binding;
}
