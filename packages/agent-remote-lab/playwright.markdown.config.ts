import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config.js';

export default defineConfig(base, {
  testMatch: 'markdown-reading.spec.ts',
  projects: [
    ...(base.projects ?? []),
    { name: 'webkit-desktop', use: { ...devices['Desktop Safari'] } },
    { name: 'webkit-mobile', use: { ...devices['iPhone 13'] } },
  ],
});
