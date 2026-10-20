import { watchPageResume } from '@orchardworks/agent-remote-web';

/** The content-hashed module entry an index document loads; development servers have none. */
export function deploymentEntry(html: string): string | undefined {
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const source = /\bsrc=["']([^"']+)["']/i.exec(tag)?.[1];
    if (source?.startsWith('/assets/')) return source;
  }
  return undefined;
}

export function runningDeploymentEntry(document: Document): string | undefined {
  for (const script of document.querySelectorAll('script[type="module"][src]')) {
    const source = script.getAttribute('src');
    if (source?.startsWith('/assets/')) return source;
  }
  return undefined;
}

async function fetchIndex(): Promise<string> {
  const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('The site index is unavailable.');
  return response.text();
}

/**
 * Pages and installed apps can stay open across deployments and keep running superseded code, including
 * fixes that only reach a page when it loads. Compares the deployed entry when the page resumes and periodically.
 */
export function watchDeploymentUpdate(options: { running: string | undefined; onUpdate(): void; fetchIndex?: () => Promise<string>; intervalMs?: number }): () => void {
  const running = options.running;
  if (!running) return () => undefined;
  let stopped = false, checking = false, updated = false;
  const check = async () => {
    if (stopped || checking || updated) return;
    checking = true;
    try {
      const deployed = deploymentEntry(await (options.fetchIndex ?? fetchIndex)());
      if (!stopped && deployed && deployed !== running) { updated = true; options.onUpdate(); }
    } catch { /* Offline and failed checks try again on the next resume or interval. */ }
    finally { checking = false; }
  };
  const timer = setInterval(() => void check(), options.intervalMs ?? 10 * 60_000);
  const unwatch = watchPageResume(() => void check());
  return () => { stopped = true; clearInterval(timer); unwatch(); };
}
