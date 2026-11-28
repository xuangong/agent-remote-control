/** The public address of a webhook: the Relay's origin, `/hooks/`, the account's namespace and the token; none where the page is not on an account's address. */
export function hookUrlOf(baseUrl: string, token: string, page = typeof location === 'undefined' ? 'http://localhost/' : location.href): string | undefined {
  const base = new URL(baseUrl, page), namespace = /^\/u\/([^/]+)\/?$/.exec(base.pathname)?.[1];
  return namespace ? `${base.origin}/hooks/${namespace}/${token}` : undefined;
}
