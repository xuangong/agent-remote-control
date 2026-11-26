import type { Plugin } from 'vite';

/**
 * Moves the built page's stylesheets from the head to the end of the body, after the launch screen. A stylesheet in the head blocks
 * the first paint until it has loaded (236 KB on a first visit over a slow link), while the launch screen needs none: one at the end
 * of the body blocks only what follows it, and the entry script still waits for it, so the app never draws unstyled.
 */
export function stylesheetsAfterLaunchScreen(html: string): string {
  const links = html.match(/<link rel="stylesheet"[^>]*>/g) ?? [];
  if (!links.length) return html;
  const head = links.reduce((rest, link) => rest.replace(link, ''), html);
  if (!head.includes('</body>')) throw new Error('The page has no body to move its stylesheets into.');
  return head.replace('</body>', `    ${links.join('\n    ')}\n  </body>`);
}

export function launchScreen(): Plugin {
  return { name: 'orchard-launch-screen', apply: 'build', transformIndexHtml: { order: 'post', handler: stylesheetsAfterLaunchScreen } };
}
