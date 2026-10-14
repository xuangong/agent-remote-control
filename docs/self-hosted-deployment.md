# Self-hosted Agent Remote

Run your own hosted website and Relay, then connect an Agent Host on your workstation.
The diagnostic Lab remains an account-free local workbench. Hosted deployments add
site login without requiring Borgee, a sibling checkout, or production credentials.
No provider CLI runs on the Relay.

## Choose runtime and sign-in independently

| Runtime | Authentication | Required services | Pairing choices |
| --- | --- | --- | --- |
| Node / Docker | Google | Your Relay, Google OAuth application | Host only |
| Cloudflare Workers | Google | Your Worker / Durable Object, Google OAuth application | Host only |
| Node / Docker | Gateway | Your Relay, your compatible Copilot API Gateway | Host only; optional Gateway token + CLI setup |
| Cloudflare Workers | Gateway | Your Worker / Durable Object, your compatible Copilot API Gateway | Host only; optional Gateway token + CLI setup |

Google login does not require any Gateway. Host only retains the Host's existing
provider configuration. Google login grants site access; it does not supply model
API credentials. Gateway setup is offered only when the server supports it and
must be selected explicitly.

## Origins, HTTPS and secrets

Choose one stable canonical origin, for example `https://agents.example.com`.
Set `AGENT_REMOTE_RELAY_URL` to that origin, without paths, credentials, query or
fragment. All browsers and Hosts must reach it. HTTP is allowed only on loopback
for development; plain HTTP on a LAN IP is unsupported and is not a browser secure
context. A public HTTPS origin can terminate TLS at a reverse proxy while Node
listens on loopback.

Generate `AGENT_REMOTE_SIGNING_SECRET` once with `openssl rand -hex 32`. Keep it
private and stable across restarts, upgrades and restores. It must contain at
least 32 bytes. Google mode uses a local Relay secret; Gateway mode shares the
same secret between your Gateway and Relay. Do not use a model API key here.
Secrets are runtime environment variables or Wrangler secrets, never build args,
source files, client assets or Docker image layers.

Keep the origin, auth provider, Google client ID (Google mode), Gateway issuer
(Gateway mode), and signing secret consistent with persisted state. Changes to
identity configuration can invalidate credentials or fail storage admission;
they are a migration/re-enrollment operation, not an ordinary upgrade. Removing
an email from the allowlist denies subsequent authorization and renewal for that
identity. Existing checks and streams can take the bounded authority refresh
interval to observe a configuration change. A fresh Google login creates a local
session (12 hours by default); it is not proof of a fresh Google password challenge.

## Google setup

Create an OAuth client of type **Web application** in your own Google Cloud project.
Configure its consent screen, audience and test users as required by your project.
Register this exact authorized redirect URI:

```text
https://agents.example.com/auth/callback
```

For a Workers default domain, substitute that exact `workers.dev` origin. Redirect
URI scheme, hostname, port and path must match the configured Relay origin.
Use the server-side authorization code flow described in
[Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).
The implementation verifies signature, issuer, audience, state, nonce, PKCE and
verified email; tokens and the client secret stay on the server.

Configure:

```dotenv
AGENT_REMOTE_AUTH_PROVIDER=google
AGENT_REMOTE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
AGENT_REMOTE_GOOGLE_CLIENT_SECRET=your-private-client-secret
AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS=owner@example.com,colleague@example.com
```

The comma-separated allowlist is mandatory, explicit email addresses only.
Addresses are trimmed and matched case-insensitively; wildcards and empty entries
are rejected. Only verified Google email claims can match it. Do not configure
`AGENT_REMOTE_ISSUER` in Google mode. A rejected or expired callback shows a retry
page and preserves a validated session target when available.

## Node / Docker from source

Install Docker Engine with Compose. Host Node/pnpm and prebuilt artifacts are not
required for this path. From a checkout of the revision you intend to deploy:

```sh
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
# Edit .env with your public origin, chosen authentication and real secrets.
chmod 600 deploy/self-hosted/.env

docker compose --project-name my-agent-remote \
  --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml config --quiet
docker compose --project-name my-agent-remote \
  --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml up -d --build
```

`Dockerfile.self-hosted` builds dependencies and the application inside Docker,
using the pinned pnpm version and Tencent npm mirror. It needs registry access.
The build stage skips only optional Claude/Copilot native CLI distributions, which
run on workstations rather than the Relay. SDK code/types and build tools such as
esbuild remain installed; normal Controller installation is unchanged.
Its own ignore file excludes installed dependencies, build output, Git/worktrees,
local environment files, keys and runtime state. The final image runs as a non-root
user and contains only the bundled server and public assets, including installers.
The existing root `Dockerfile` still supports the prebuilt-artifact release/test
workflow; the existing root Compose topology is a separate Gateway integration lab.

The new Compose service exposes `127.0.0.1:5910` by default. Change
`AGENT_REMOTE_HTTP_PORT` in `.env` to an unused host port. Put your TLS reverse
proxy on that host in front of it; forward all paths, WebSocket upgrades, the
original public `Host` and browser `Origin`. Do not substitute the loopback Host:
Node deliberately validates it against the configured public origin. The container
healthcheck connects locally with the configured public Host, so it needs no
public DNS or TLS route to test process health.

Verify the public site and `/health` through HTTPS after configuring DNS/proxy.
Sign-in, browser secure context, Host WSS registration and reconnection need an
end-to-end check; a healthy container alone does not establish those properties.
Optional preview hostnames additionally need matching DNS/TLS/proxy routing.

## Cloudflare Workers

Use Node 22+ and pnpm 10.34.5 for build tooling. The independent template is
`deploy/self-hosted/wrangler.jsonc`; do not reuse the production config under
`packages/agent-remote-cloudflare/`. Change the template's Worker name, public
origin, Google client ID and email allowlist to your own values. With `workers_dev`
enabled, the origin is `https://WORKER.YOUR-SUBDOMAIN.workers.dev`. Alternatively,
configure your own Custom Domain and set that as the canonical origin.

From the repository root:

```sh
pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm/
pnpm build:relay
pnpm --filter @orchardworks/agent-remote-cloudflare run build
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy \
  --config ../../deploy/self-hosted/wrangler.jsonc --dry-run

pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler secret put \
  AGENT_REMOTE_SIGNING_SECRET --config ../../deploy/self-hosted/wrangler.jsonc
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler secret put \
  AGENT_REMOTE_GOOGLE_CLIENT_SECRET --config ../../deploy/self-hosted/wrangler.jsonc
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy \
  --config ../../deploy/self-hosted/wrangler.jsonc
```

Wrangler prompts for your own Cloudflare authentication and secret values. The
Google secret command is needed only in Google mode. Keep secrets out of `vars`.
The template binds public assets and a SQLite-backed `RelayObject` under `RELAY`,
with a stable `primary` object. Keep that binding, class, Worker identity and
migration history stable during upgrades. The Worker has no Gateway D1/KV/R2
bindings. Do not remove/recreate the namespace to fix configuration errors.

## Gateway setup

Choose `AGENT_REMOTE_AUTH_PROVIDER=gateway` (also the compatibility default when
unset). Set `AGENT_REMOTE_ISSUER` to your own compatible Gateway HTTPS origin and
configure the same Relay URL, issuer and signing secret on both services. In the
Workers template, replace Google vars with `AGENT_REMOTE_AUTH_PROVIDER` and
`AGENT_REMOTE_ISSUER`. The Gateway must implement the Agent Remote signed login,
authority renewal and control integration; an arbitrary OpenAI-compatible model
endpoint is not an identity Gateway. Follow [Gateway integration](current/agent-remote/gateway-relay.md)
and the Gateway project's own `vnext/docs/agent-remote-relay.md`.

The Relay serves `/auth/login`, and your Gateway handles `/agent-remote` before
returning the browser to this Relay. No production business domain is required.
If both are Workers in the same zone, use appropriate Custom Domains for their
server-to-server calls; do not assume a wildcard route is interchangeable.

## Pair one Controller with this site

Open your deployment, select **Sign in**, then **Settings → Pair Agent Host**.
The account label and installer target refer to this site. Choose **Host only**
unless you intentionally want the optional **Gateway token + CLI setup**. Generate
a key and run the displayed command on the computer that will execute agents:

```sh
curl -fsSL 'https://agents.example.com/install.sh' | sh -s -- --server 'https://agents.example.com'
```

In PowerShell:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://agents.example.com/install.ps1'))) -Server 'https://agents.example.com'
```

The website serves the installer script; the installer downloads a published,
verified Controller release from the public GitHub repository. Node/npm and native
provider setup requirements are in [Controller installation](controller-install.md).
Enter the one-time key privately when prompted. Existing installations retain the
installer's update/clean/cancel confirmation. These commands explicitly select
your Relay, so the installer's default public site is not used.

For an already installed Controller, use the site's generated command or set
`AGENT_HOST_SERVER=https://agents.example.com` and supply `AGENT_HOST_REMOTE_KEY`
privately before `agent-remote-controller start`. Use `agent-remote-controller pair`
with both environment variables only when deliberately replacing an already-running
Host's uplink. The `--server` / `-Server` flags above belong to the installers. The
Controller supports an explicit server URL and a single active site per Host state
directory; this deployment does not
add multi-site pairing. Preserve its local state and native sessions during upgrades.
The diagnostic Lab uses repository-hosted installers and its actual pairing URL;
it does not assume that the Vite origin is a hosted Relay.

## Persistence, backups and upgrades

Node Compose owns a named `relay-state` volume mounted at `/data`. Keep the same
Compose project name and volume across upgrades. Only one Relay process may own
this state; do not remove its lock file or run a second writer. Keep the entire
state directory, including resource files and diagnostics, not just `state.json`.
The state and its authentication envelope are coupled to the deployment's signing
secret and configured identity. Back up the private `.env` separately and securely.
Provider sessions and workspaces live on Hosts and require their own backups.

For a coherent Node backup, stop this Compose service, take a volume snapshot or
archive the complete volume with your storage tooling, then restart it. Do not
combine independently timed live copies and call them a transactional backup.
Protect archives as sensitive account/credential/resource data. Restore the whole
volume with the matching configuration and secret; check ownership permissions
for the image's `node` user before starting one writer. Test restores in an isolated
environment before relying on them. Do not use `docker compose down -v` for upgrades.

Workers persist application data in the deployment's Durable Object SQLite
storage, subject to platform limits and the application's stricter admission
budgets. Capacity failure must be investigated; bypassing guards or deleting
storage can break authorization and recovery. See [Durable Object storage](https://developers.cloudflare.com/durable-objects/api/storage-api/)
for platform APIs and current recovery facilities. This repository provides no
operator-level portable export/import, automated backup schedule, or Node-to-Workers
migration command. A Worker bundle/config backup is not a data backup. Confirm
which platform recovery features and retention your account supports, and test
recovery before deployment. Native Host data remains a separate backup boundary.

Before upgrading, record the deployed commit/image, preserve configuration and
backups, and review [protocol upgrade guidance](protocol-upgrade-runbook.md).
Build the new image (or Workers bundle), validate it in isolation, then update the
existing service with the same data and identity settings. Expect clients/Hosts to
reconnect; verify public health, sign-in, Host identity and session access. Preserve
the old artifact for rollback, but do not assume an older build can read a newer
state format. A tested state restore may be necessary. Changes requiring a newer
Controller must follow the documented compatibility rollout before enabling them.

Local fixture tests can verify signed OAuth flow, cookies, allowlist behavior,
pairing, persistence and UI. They do not verify your real Google account, consent
screen, Cloudflare account, public DNS or TLS configuration.
