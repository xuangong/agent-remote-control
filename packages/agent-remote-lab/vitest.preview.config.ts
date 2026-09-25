import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', include: ['e2e/pending-send.browser.ts', 'e2e/timeline-scroll.browser.ts', 'e2e/browser-inventory.browser.ts', 'e2e/favorites.browser.ts', 'e2e/preview-groups.browser.ts', 'e2e/preview-subdomain.browser.ts', 'e2e/preview.browser.ts', 'e2e/markdown-images.browser.ts', 'e2e/file-resources.browser.ts', 'e2e/session-recovery.browser.ts'],
  testTimeout: 30_000, hookTimeout: 15_000, maxWorkers: 1 } });
