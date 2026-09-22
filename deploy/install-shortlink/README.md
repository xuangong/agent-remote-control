# Controller installer short link

`https://install.xianliao.de5.net/` redirects with HTTP 302 to the latest GitHub
Release's `install.sh`. The response is not cached, requires no login and does not
forward query parameters. Only GET and HEAD at the exact root URL are accepted.

```sh
curl -fsSL https://install.xianliao.de5.net | sh
# Also install the pinned Codex CLI if it is missing:
curl -fsSL https://install.xianliao.de5.net | sh -s -- --install-codex
```

Deploy this independent Worker from the repository root:

```sh
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy \
  --config ../../deploy/install-shortlink/wrangler.jsonc
```

Cloudflare provisions the Custom Domain DNS record and TLS certificate. This Worker
has no Relay, storage, authentication or secret bindings. It does not proxy or store
installer bytes; clients follow the redirect to GitHub. Release publication remains
independent of this deployment. To disable the short link, remove its Custom Domain
and Worker; GitHub installation URLs remain available.
