import { createHash } from 'node:crypto';

export function previewDomainOrigin(id: string, domain: string, controlOrigin: string): string {
  assertPreviewDomain(domain);
  const url = new URL(controlOrigin);
  url.hostname = `t-${createHash('sha256').update(id).digest('hex').slice(0, 48)}.${domain}`;
  return url.origin;
}

export function isPreviewDomain(value: string, domain: string | undefined, controlOrigin: string): boolean {
  if (!domain) return false;
  assertPreviewDomain(domain);
  const url = new URL(value); const control = new URL(controlOrigin);
  const suffix = `.${domain}`;
  return url.protocol === control.protocol && url.port === control.port && url.hostname.endsWith(suffix)
    && /^t-[a-f0-9]{48}$/.test(url.hostname.slice(0, -suffix.length));
}

function assertPreviewDomain(domain: string): void {
  if (domain.length > 200 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    || domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))
    throw new Error('Invalid preview domain. Use a lowercase DNS suffix without a scheme or port.');
}

export function controllerContentSecurityPolicy(controlOrigin: string, previewDomain?: string): string {
  const source = previewDomain ? previewDomainOrigin('policy', previewDomain, controlOrigin).replace(/t-[a-f0-9]{48}\./, '*.') : undefined;
  return `default-src 'self'; connect-src 'self'${source ? ' ' + source : ''}; frame-src 'self'${source ? ' ' + source : ''}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`;
}
