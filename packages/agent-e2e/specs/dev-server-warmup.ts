/**
 * Playwright global setup: requests the Lab's module graph from the Vite dev server once, so Vite has transformed it
 * before the first test loads the page. A cold dev server otherwise takes about as long as an assertion's timeout to
 * show the app, and the first test of every run failed. Fetching modules does not run the app, so no Relay state is created.
 */
export default async function warmDevServer(config: { projects: { use: { baseURL?: string } }[] }): Promise<void> {
  const base = config.projects[0]?.use.baseURL;
  if (!base) return;
  const seen = new Set<string>(), queue = ['/src/main.tsx'];
  const started = Date.now();
  while (queue.length && Date.now() - started < 120_000) {
    const batch = queue.splice(0, 16);
    await Promise.all(batch.map(async path => {
      const response = await fetch(new URL(path, base)).catch(() => undefined);
      if (!response?.ok || !/javascript|typescript/.test(response.headers.get('content-type') ?? '')) return;
      // Vite rewrites every import to an absolute URL; follow the static and dynamic ones.
      for (const match of (await response.text()).matchAll(/(?:import|from)\s*\(?\s*["'](\/[^"']+)["']/g)) {
        const next = match[1]!;
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }));
  }
}
