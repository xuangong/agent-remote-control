import { expect, it } from 'vitest';
import { previewDomainOrigin, isPreviewDomain } from './preview-domain.js';

it('maps case-sensitive registrations to distinct DNS-safe origins', () => {
  const first = previewDomainOrigin('Ab_C', 'xianliao.de5.net', 'https://agents.xianliao.de5.net');
  expect(new URL(first).hostname).toMatch(/^t-[a-f0-9]{48}\.xianliao\.de5\.net$/);
  expect(first).not.toBe(previewDomainOrigin('ab_c', 'xianliao.de5.net', 'https://agents.xianliao.de5.net'));
  expect(isPreviewDomain(first, 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(true);
  expect(isPreviewDomain(first + '.evil.test', 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
  expect(isPreviewDomain('https://token.xianliao.de5.net', 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
  expect(isPreviewDomain(first.replace('https:', 'http:'), 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
});
