/**
 * The flows that run in Chromium only. The bot flows drive scripted sessions and tools through the Relay and Controller; the page
 * they open renders the same bot words and lists that WebKit already renders in the component tier and in the other flows, so a
 * second engine would add time (about 50 s of the WebKit tier) and no browser-specific check.
 */
export const CHROMIUM_ONLY_FLOWS = ['E15', 'E15b', 'E15c', 'E15d'];

/** Vitest `exclude` globs for the flow files of those flows, used when `E2E_BROWSER=webkit`. */
export const chromiumOnlyFlowGlobs = () => CHROMIUM_ONLY_FLOWS.map(id => `flows/${id.toLowerCase()}-*.e2e.ts`);
