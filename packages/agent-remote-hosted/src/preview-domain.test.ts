import { expect, it } from 'vitest';
import { previewDomainOrigin, isPreviewDomain, controllerContentSecurityPolicy } from './preview-domain.js';

it('maps case-sensitive registrations to distinct DNS-safe origins', () => {
  const first = previewDomainOrigin('Ab_C', 'xianliao.de5.net', 'https://agents.xianliao.de5.net');
  expect(new URL(first).hostname).toMatch(/^[a-z]+-[a-z]+-[a-f0-9]{12}\.xianliao\.de5\.net$/);
  expect(first).not.toBe(previewDomainOrigin('ab_c', 'xianliao.de5.net', 'https://agents.xianliao.de5.net'));
  expect(isPreviewDomain(first, 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(true);
  expect(isPreviewDomain(first + '.evil.test', 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
  expect(isPreviewDomain('https://token.xianliao.de5.net', 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
  expect(isPreviewDomain(first.replace('https:', 'http:'), 'xianliao.de5.net', 'https://agents.xianliao.de5.net')).toBe(false);
});

it('keeps registration origins stable and preserves the configured port', () => {
  const origin = previewDomainOrigin('Ab_C', 'arc.test', 'https://control.arc.test:8443');
  expect(previewDomainOrigin('Ab_C', 'arc.test', 'https://control.arc.test:8443')).toBe(origin);
  expect(new URL(origin).port).toBe('8443');
  expect(isPreviewDomain(origin, 'arc.test', 'https://control.arc.test:8443')).toBe(true);
  expect(isPreviewDomain(origin, 'arc.test', 'https://control.arc.test')).toBe(false);
});

it('accepts friendly names and rejects legacy or unrecognized names', () => {
  const check = (label: string) => isPreviewDomain(`https://${label}.arc.test`, 'arc.test', 'https://control.arc.test');
  expect(check('mint-otter-7a3c91e2b604')).toBe(true);
  expect(check('t-f21f2b6e80d9b430f15b7e2563087b4e78cff8565af2bead')).toBe(false);
  expect(check('unknown-otter-7a3c91e2b604')).toBe(false);
  expect(check('mint-unknown-7a3c91e2b604')).toBe(false);
  expect(check('mint-otter-7a3c91e2b60')).toBe(false);
  expect(check('nested.mint-otter-7a3c91e2b604')).toBe(false);
});

it('allows preview connections and frames across the configured wildcard origin', () => {
  const policy = controllerContentSecurityPolicy('https://control.arc.test:8443', 'arc.test');
  expect(policy).toContain("connect-src 'self' https://*.arc.test:8443;");
  expect(policy).toContain("frame-src 'self' https://*.arc.test:8443;");
  expect(controllerContentSecurityPolicy('https://control.arc.test')).toContain("frame-src 'self';");
});
