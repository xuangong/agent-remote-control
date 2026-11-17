import { createHash } from 'node:crypto';

// Keep the dictionaries and their order stable: existing registration URLs depend on them.
const colors = ['amber', 'azure', 'coral', 'cyan', 'gold', 'indigo', 'ivory', 'jade', 'lilac', 'lime', 'mint', 'peach', 'rose', 'ruby', 'teal', 'violet'];
const animals = ['badger', 'bear', 'bison', 'cat', 'crane', 'deer', 'dolphin', 'dove', 'falcon', 'finch', 'fox', 'gecko', 'heron', 'koala', 'lemur', 'lion', 'lynx', 'marten', 'otter', 'owl', 'panda', 'parrot', 'puma', 'rabbit', 'raven', 'seal', 'sparrow', 'swan', 'tiger', 'turtle', 'whale', 'wolf'];
const previewLabelPattern = new RegExp(`^(?:${colors.join('|')})-(?:${animals.join('|')})-[a-f0-9]{12}$`);

export function previewDomainOrigin(id: string, domain: string, controlOrigin: string): string {
  assertPreviewDomain(domain);
  const url = new URL(controlOrigin);
  const hash = createHash('sha256').update(id).digest('hex');
  const color = colors[Number.parseInt(hash.slice(0, 2), 16) % colors.length];
  const animal = animals[Number.parseInt(hash.slice(2, 4), 16) % animals.length];
  url.hostname = `${color}-${animal}-${hash.slice(4, 16)}.${domain}`;
  return url.origin;
}

export function isPreviewDomain(value: string, domain: string | undefined, controlOrigin: string): boolean {
  if (!domain) return false;
  assertPreviewDomain(domain);
  const url = new URL(value); const control = new URL(controlOrigin);
  const suffix = `.${domain}`;
  return url.protocol === control.protocol && url.port === control.port && url.hostname.endsWith(suffix)
    && previewLabelPattern.test(url.hostname.slice(0, -suffix.length));
}

function assertPreviewDomain(domain: string): void {
  if (domain.length > 200 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)
    || domain.split('.').some(label => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-')))
    throw new Error('Invalid preview domain. Use a lowercase DNS suffix without a scheme or port.');
}

export function controllerContentSecurityPolicy(controlOrigin: string, previewDomain?: string): string {
  let source: string | undefined;
  if (previewDomain) {
    assertPreviewDomain(previewDomain);
    const url = new URL(controlOrigin);
    url.hostname = `*.${previewDomain}`;
    source = url.origin;
  }
  return `default-src 'self'; connect-src 'self'${source ? ' ' + source : ''}; frame-src 'self'${source ? ' ' + source : ''}; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'`;
}
