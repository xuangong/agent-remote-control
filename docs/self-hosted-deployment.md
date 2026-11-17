# Self-hosted Agent Remote

Run your own hosted website and Relay, then connect an Agent Host on your workstation.
The diagnostic Lab remains an account-free local workbench. Hosted deployments add
site login using your own configuration and credentials.
No provider CLI runs on the Relay.

Start with the [README deployment walkthrough](../README.md#private-deployment)
for authentication, Docker or Workers, [Caddy with Let's Encrypt](../README.md#caddy-and-lets-encrypt),
and [Controller installation](../README.md#install-controller). This guide adds
runtime and backup details to that operator-facing flow.

## Choose runtime and sign-in independently

| Runtime | Authentication | Required services | Pairing choices |
| --- | --- | --- | --- |
| Node / Docker | Google | Your Relay, Google OAuth application | Host only |
| Cloudflare Workers | Google | Your Worker / Durable Object, Google OAuth application | Host only |
| Node / Docker | Main site | Your Relay, your main site implementing the authentication contract | Host only; optional model key + CLI setup |
| Cloudflare Workers | Main site | Your Worker / Durable Object, your main site implementing the authentication contract | Host only; optional model key + CLI setup |

Direct Google login does not require a main site. Host only retains the Host's
existing provider configuration. Google login grants site access; it does not
supply model API credentials. Main-site login uses the configuration value
`mainsite`; model-key setup is optional and currently labeled **Gateway token + CLI
setup** in the UI. That mode advertises setup/control capabilities without probing
the main site's endpoints, so use **Host only** unless those APIs are implemented.

## Origins, HTTPS and secrets

Choose one stable canonical origin, for example `https://agents.example.com`.
Set `AGENT_REMOTE_RELAY_URL` to that origin, without paths, credentials, query or
fragment. All browsers and Hosts must reach it. HTTP is allowed only on loopback
for development; plain HTTP on a LAN IP is unsupported and is not a browser secure
context. A public HTTPS origin can terminate TLS at a reverse proxy while Node
listens on loopback.

Generate `AGENT_REMOTE_SIGNING_SECRET` once with `openssl rand -hex 32`. Keep it
private and stable across restarts, upgrades and restores. It must contain at
least 32 bytes. Google mode uses a local Relay secret; main-site login shares the
same secret between your main site and Relay. Do not use a model API key here.
Secrets are runtime environment variables or Wrangler secrets, never build args,
source files, client assets or Docker image layers.

Keep the origin, auth provider, Google client ID (Google mode), main-site issuer
(main-site login), and signing secret consistent with persisted state. Changes to
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
workflow; the existing root Compose topology is a separate main-site integration lab.

The new Compose service exposes `127.0.0.1:5910` by default. Change
`AGENT_REMOTE_HTTP_PORT` in `.env` to an unused host port. Put your TLS reverse
proxy on that host in front of it; forward all paths, WebSocket upgrades, the
original public `Host` and browser `Origin`. Do not substitute the loopback Host:
Node deliberately validates it against the configured public origin. The container
healthcheck connects locally with the configured public Host, so it needs no
public DNS or TLS route to test process health.

Use the [README Caddy configuration](../README.md#caddy-and-lets-encrypt) for
Let's Encrypt issuance and renewal, host-installed versus container upstreams,
and the matching Relay origin and Google callback. Preserve Caddy's certificate
data separately from Relay state. TLS certificate renewal does not rotate
`AGENT_REMOTE_SIGNING_SECRET`; changing that application secret can invalidate
persisted state.

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
migration history stable during upgrades. The Worker has no main-site D1/KV/R2
bindings. Do not remove/recreate the namespace to fix configuration errors.

## Main-site setup

Choose `AGENT_REMOTE_AUTH_PROVIDER=mainsite`. The default when unset is also
`mainsite`; the previous `gateway` value remains a compatibility alias. New
deployments should explicitly select `google` or `mainsite`. Renaming an existing
configuration from `gateway` to `mainsite` preserves its identity and stored state.
Set `AGENT_REMOTE_ISSUER` to your main site's HTTPS origin and
configure the same Relay URL, issuer and signing secret on both services. In the
Workers template, replace Google vars with `AGENT_REMOTE_AUTH_PROVIDER` and
`AGENT_REMOTE_ISSUER`. The main site must implement the Agent Remote signed login
and authority APIs. A model API alone does not provide this identity integration;
a model API is not required for authentication-only integration. Follow the
[main-site API and data contract](../README.md#main-site-api-and-data-requirements)
and [integration guide](current/agent-remote/gateway-relay.md).

The Relay serves `/auth/login`, and your main site handles `/agent-remote` before
returning the browser to this Relay. No production business domain is required.
If both are Workers in the same zone, use appropriate Custom Domains for their
server-to-server calls; do not assume a wildcard route is interchangeable.

Sign in to the main site before launching Agent Remote. If that site uses Google,
use the same Google/Gmail account you use on the main site; its login supplies the
identity for Agent Remote, without a separate Google login on the Relay. Other
main-site login methods are supported by the same contract. Identity follows the
main site's stable issuer and subject, not an email match. Direct Google login
has a separate namespace: an identical Gmail address does not merge accounts,
Host ownership or permissions across these two modes.

## Pair one Controller with this site

The root [install.sh](../install.sh) and [install.ps1](../install.ps1) are the
macOS/Linux and Windows installers. The Relay build publishes them at the site
paths below. For commands that run directly from a checkout, see
[Install Controller](../README.md#install-controller).

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

## Session journals (optional, off by default)

A Relay can keep a working copy of each session's conversation, so a session can be read without waiting for its
Controller. This is an opt-in feature in development: it does nothing until a Controller that publishes journals is
installed, and nothing reads from a journal until the owner turns it on for a Host and provider.

| Setting | Meaning |
| --- | --- |
| `AGENT_REMOTE_JOURNALS=1` | Turns journals on. Node / Docker: stores them in `journals.sqlite` in the state directory (`AGENT_REMOTE_STATE_DIR`); needs Node 22.13 or later (the image uses Node 22) and prints one `ExperimentalWarning` for Node's built-in SQLite. Workers: keeps them in the journal partitions (below); set it as a variable. Unset or any other value: no journals. |
| run `agent-remote-controller login` once, then `agent-remote-controller api PUT /v1/remote/hosts/<host id>/smart-reading --body '{"providerId":"codex","enabled":true}'` | The owner turns reading from journals on or off for one provider of one Host. The command line signs in as the owner and adds the account prefix, session, `Origin` and content type a direct request would need. The default is off. Turning it off closes that provider's journal-served streams so their pages reconnect and read through the Controller. `agent-remote-controller api GET /v1/remote/hosts/<host id>/smart-reading` lists the providers that are on. |

Journals are a working set, not an archive: the native session on the Host is the ground truth. The Relay keeps the
bodies of the latest 50 turns of a session, bounds each session, each Host and its memory, and a Controller can read
evicted turns again from the Host. Items nothing can rebuild (live-only items) are kept, up to a cap per session. A
session whose journal a limit refused is read through the Controller until its Controller publishes again. Revoking a
Host deletes its journals; the Relay records the deletion with the revoke and retries it at start and whenever a Host
registers, until the store confirms. The list of pending deletions holds 1,024 Hosts; a revoke that finds it full drops the
oldest id, whose journals are then no longer deleted automatically (there is no supported way to remove them later short
of deleting the database file while the Relay is stopped), and the Relay records a diagnostic. The journal file is inside
the state directory, so the backup rules below cover it; copy it only while the Relay is stopped.

On Cloudflare Workers the journals live in one Durable Object per Host (`JournalPartition`, bound as `JOURNALS`), in a
Worker of its own, not in the main Relay object: they do not count toward its state bound, and a busy partition cannot
reset the Relay's connections. The default Relay configuration has neither the binding nor the variable and deploys as it
always did; see [Enabling journals on Workers](#enabling-journals-on-workers) for the steps and their order. Without the
binding or the variable, no Controller is granted journals. A partition keeps at most 2 journals (20 MiB estimated)
in memory, refuses growth of a session past 12 MiB, and stores at most 1 GiB per Host. Revoking a Host empties its partition.

### Enabling journals on Workers

The default `wrangler.jsonc` deploys exactly as before: it has no journal binding and no journal variable, so deploying it
never needs the partitions Worker. To turn journals on, follow these steps in this order:

1. Deploy the partitions Worker with its migration: `wrangler deploy --config ../../deploy/self-hosted/wrangler.journals.jsonc`
   (name `my-agent-remote-journals`; no routes, no variables, no secrets, and it answers no request).
2. Switch the Relay to `deploy/self-hosted/wrangler.journals-enabled.jsonc`: your Relay configuration plus the
   `JOURNALS` binding (`script_name` names the partitions Worker; keep both names in step if you rename them). If you
   edited `wrangler.jsonc`, make the same edits there, then add the binding to it:
   `{ "name": "JOURNALS", "class_name": "JournalPartition", "script_name": "my-agent-remote-journals" }`.
3. Set the variable `AGENT_REMOTE_JOURNALS` to `1` (the journals-enabled file sets it; with your own file, add it to `vars`).
4. Deploy the Relay: `wrangler deploy --config ../../deploy/self-hosted/wrangler.journals-enabled.jsonc`.

Dry-run each file first with `wrangler deploy --dry-run --config <file>`. With the variable set but no `JOURNALS`
binding, the Relay does not fail: it logs `Configuration error: AGENT_REMOTE_JOURNALS is 1 but this Worker has no JOURNALS
binding` and runs without journals.

Rollout rule: always deploy the partitions Worker first. Between the Relay and the partitions Worker, existing methods and
fields never change, and anything new is added as an optional field or a new method. The Relay asks each partition for its
`capabilities` once, grants Controllers no more than the partition reports, and treats a partition that does not answer
(an older one) as the earliest version, so a newer Relay never relies on a method an older partitions Worker lacks.

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

**Upgrade the Relay before the Controllers, and never roll it back below the release that introduced Relay-owned
session control.** From that release the Relay owns every session-control lease. A Controller offers `control=1` when it
connects, the Relay acknowledges it, and a Controller opens sessions only on an acknowledged connection. An older
Controller still registers, appears in the Hosts list and can be updated from the website, but it cannot open sessions
until it is updated; the Hosts page says "Update required". An updated Controller connected to an older Relay shows
"Update the Relay" and opens no session. Deploy the Relay first, then update each Controller. For a machine that cannot be
updated from the website, run `agent-remote-controller update --check` on it, or follow [Controller install](controller-install.md).

Local fixture tests can verify signed OAuth flow, cookies, allowlist behavior,
pairing, persistence and UI. They do not verify your real Google account, consent
screen, Cloudflare account, public DNS or TLS configuration.
