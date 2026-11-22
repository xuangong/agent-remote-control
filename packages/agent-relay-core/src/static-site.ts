/**
 * The website's files besides its built bundles under `/assets/`: the installers, the brand icons, the manifest and the app's service
 * worker. The Node Relay and the Cloudflare Worker serve exactly these from the built Workbench, so a file the page links needs an
 * entry here, and a source file never leaks.
 */
export const STATIC_SITE_FILES: readonly string[] = [
  '/install.sh', '/install.ps1', '/favicon.svg', '/favicon.ico', '/sw.js', '/app/manifest.webmanifest', '/app/favicon-32.png',
  '/app/apple-touch-icon.png', '/app/icon-192.png', '/app/icon-512.png', '/app/icon-maskable-192.png', '/app/icon-maskable-512.png',
  '/app/icon-monochrome-192.png', '/app/icon-monochrome-512.png',
];

/** The app's service worker; its scope is the whole site, so it is served from the root. */
export const SERVICE_WORKER_PATH = '/sw.js';

/** The cache policy of the website's built bundles under `/assets/`. Their names carry a content hash, so a returning page loads its code from the browser and does not wait on the network. */
export const BUILT_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** A browser checks the service worker for an update at every navigation; no cache between may answer with an old copy. */
export const SERVICE_WORKER_CACHE_CONTROL = 'no-cache';

/** Whether `path` is a static site file: a built bundle or one of the files above. */
export function isStaticSiteFile(path: string): boolean {
  return path.startsWith('/assets/') || STATIC_SITE_FILES.includes(path);
}

/** The cache policy a static site file is served with: built bundles are immutable, the service worker revalidates, the rest as the store gives them. */
export function staticFileCacheControl(path: string): string | undefined {
  return path.startsWith('/assets/') ? BUILT_ASSET_CACHE_CONTROL : path === SERVICE_WORKER_PATH ? SERVICE_WORKER_CACHE_CONTROL : undefined;
}
