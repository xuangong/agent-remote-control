# Agent Remote Control

Run your coding agents on your own machines and work with them from one browser workspace. Agent Remote Control connects to Codex, Claude Code, GitHub Copilot, OpenCode, and DSH, with shared session views, saved Window layouts, and collaboration across Hosts.

Use a wide screen to work across several conversations, or open the same workspace on a phone to focus on one at a time. Self-host the website with Docker or Cloudflare Workers; Controller connects the machines where your agents and project directories live.

[Feature tour](#feature-tour) · [Try the Devbox](#local-devbox) · [Private deployment](#private-deployment) · [Install Controller](#install-controller) · [Pair a Host](#pair-controller-with-your-site)

## Feature tour

### Work across sessions without losing your place

[![Several Session Views arranged side by side, with Host and provider discovery in the sidebar.](docs/images/session-workspace.png)](docs/images/session-workspace.png)

Keep an implementation conversation, a review, and another project's work open together. Each **Session View** has its own conversation, composer, runtime status, and display mode. On wide screens, resize panes and scroll the workspace horizontally; attached subagents stay beside their source view as a group.

Click a pane's title, conversation, or composer to select it. Choosing a session from the sidebar, Favorites, or Track, or creating a new session, replaces that pane's conversation. To keep the current conversation open, first use **Window → New session view** to add an empty pane and select its session afterward. Ask, Team, and TPM panes stay attached to their own conversations; use an ordinary or empty pane to open a different session.

Use **Ask** for a separate contextual discussion and **/side** for a related working conversation. Show the Ask entry with **View → Ask view** or **/ask**. Both use the same Session View as other sessions. Ask can float above the workspace or **Dock** alongside it when there is enough room. On narrow screens, the foreground conversation is already selected; switch views through the Window list instead of navigating a horizontal canvas.

*Screenshots show real working sessions. Click any image to view it at full size.*

### Keep and share your Window layouts

<a href="docs/images/window-manager.png"><img src="docs/images/window-manager.png" alt="Window manager with two saved Windows and a list of selectable, closable Session Views." width="360"></a>

A **Window** holds a layout of Session Views. Use the floating **Window** button to switch workspaces, add an empty view, or return to an existing pane. For example, keep one Window for a feature and another for deployment work, each with the conversations you need.

Layouts restore on refresh and reopen. Pane changes appear locally first while saving and synchronization happen in the background. Opening the same Window link in another page shares its layout and selection. Closing panes changes the layout without stopping native sessions; dependent views close together, such as a Leader and its member panes. To delete a Window, switch to another valid Window first, then delete the inactive one from the list.

An authorized agent can also inspect and arrange a Window through `agent-remote-controller window` commands. See [Shared Window workspaces](#shared-window-workspaces) and the [Window command guide](docs/guides/window-agent-operations.md).

### Put a Team on work that spans machines

[![A Team Leader and a Windows member working in neighboring Session Views within the horizontally scrolled workspace.](docs/images/team-workspace.png)](docs/images/team-workspace.png)

Use a **Team** when a task needs agents in different environments: investigate on a Mac, reproduce on Windows, and validate on Linux. Select the source project session, open **Team**, and choose **New team**. A separate Leader starts in the source working directory. Discuss the goal with the Leader, then use **Manage team → Add member** to select an online paired Host, a provider, and a working directory from that Host's folder browser.

The Leader can implement work itself and send tasks to members, collect their findings, and coordinate validation. Members run in their own native environments and permissions. The source session stays separate from this collaboration; it does not need to manage the Team.

<a href="docs/images/team-manager.png"><img src="docs/images/team-manager.png" alt="Team manager grouping Teams by source session, with worker counts, Rename, Manage team, Archived, and New team controls." width="360"></a>

The Team list groups work by source session so you can see which project each group belongs to. **Manage team** holds membership and archive actions. Opening a Team arranges its source, Leader, and members using ordinary Session Views on wide screens. **Gather** brings missing member views back; closing a member pane does not remove the member. On a phone, opening the Team shows its Leader; use the session selector in the Team list to switch to members.

Use **View → Team view** or **/team** to show or hide the management entry. For files such as logs, reports, or build archives, members can use explicit [Team resource transfers](docs/guides/team-resources.md); working directories are not automatically shared between Hosts.

### Give one deliverable a dedicated TPM

<a href="docs/images/tpm-manager.png"><img src="docs/images/tpm-manager.png" alt="TPM work list grouped by source session, with Needs you and New indicators, archived work, and New TPM session." width="360"></a>

A **TPM** is a conversation dedicated to clarifying a requirement and following it through delivery. Select the session doing the implementation, open **TPM**, and choose **New TPM session**. Start talking without filling in a title or a specification first; the work can be named as the goal becomes clear.

The TPM helps develop the plan and acceptance criteria, sends requests to its source session, checks progress and evidence, and reports back. Unlike a Team Leader, it coordinates implementation with that session rather than implementing product code itself. The TPM list groups work by source session and highlights items that need your attention. On a phone, open one TPM conversation at a time and use this list to switch between work items.

New work starts in manual mode. Choose **Delegate** in the TPM workspace to enable Controller-owned background follow-up, including heartbeats. This continues while the browser is closed, provided the Host and model service remain available. Click **Delegated** to return to manual discussion; archive the work when it is finished. Use **View → TPM view** or **/tpm** to show the entry. See [TPM delivery](docs/tpm-delivery.md) for plans, acceptance, and recovery behavior.

### Attach files and share results

Use **… → Resource** in the composer to attach ordinary files as `[resource #N]` references. Agents receive verified Host-local files, and sent messages provide downloads. Team members can exchange archives and reports through `upload_team_resource`, `send_team_message`, and `download_team_resource` without encoding file contents in message text. See [Resource attachments](docs/resource-attachments.md) for usage, storage, and limits.

To try the full product on one machine, start with the [Local Devbox](#local-devbox). For your own site and multiple Hosts, follow [Private deployment](#private-deployment), then install and pair Controller on each participating machine. Available session controls and collaboration features depend on the provider and the Host's advertised capabilities.

## Local Devbox

Run the complete product in one Docker container for a local trial or to validate
feature changes before deployment. It includes the full website, persistent Node
Relay, automatically configured Controller, Codex, Claude Code, Copilot and
OpenCode. Window, Ask, Side, TPM, Team, Track and Favourites use the ordinary
product implementation; this is not the diagnostic Lab.

From the source checkout you want to try:

```sh
docker compose -p arc-devbox -f deploy/devbox/compose.yaml up -d --build
```

Open **http://localhost:5910**. Website authentication is skipped for a fixed
local Devbox identity, and Controller pairing is automatic. No Google or main
site is needed. Configure a native provider's own login or model credentials to
start using that provider; missing model credentials do not prevent the website
from opening. The default port is exposed on host loopback only.

The website and Controller are built from the same source tree. Docker volumes
retain application state, native profiles, sessions and the workspace across
restarts and image rebuilds. This local entry does not change production login.
See [Devbox setup and usage](docs/devbox.md) for provider login, alternate ports,
workspace mounts, logs, rebuilds and data retention.

## Private deployment

Host the website and Relay yourself, then install **Agent Remote Controller** on
each computer that runs your agents. Provider CLIs, their credentials, sessions
and project directories stay on those computers; the Relay does not run them.

1. [Choose and configure authentication](#configure-authentication).
2. Deploy with [Docker](#deploy-with-docker) or [Cloudflare Workers](#deploy-with-cloudflare-workers-cfw).
3. [Install Controller](#install-controller) and [pair it with your site](#pair-controller-with-your-site).
4. Keep [Relay data](#keep-data-across-upgrades), Caddy certificate data and Controller state across upgrades.

Deployment and authentication are independent choices:

| Deployment | Direct Google login | Main-site login | Persisted Relay data |
| --- | --- | --- | --- |
| Docker / Node | Supported | Supported | Named Docker volume |
| Cloudflare Workers (CFW) | Supported | Supported | SQLite-backed Durable Object |

| Configuration scenario | What you operate | What to configure |
| --- | --- | --- |
| Private Docker site with Google/Gmail | One Relay container behind HTTPS; no main site | Docker `.env`: `google`, Google OAuth credentials, email allowlist and Relay signing secret. |
| Private CFW site with Google/Gmail | One Worker + Durable Object; no main site | Wrangler `vars`: `google`, OAuth client ID and allowlist; signing/client secrets in Wrangler secrets. |
| Docker site integrated with your main site | Relay container + a compatible main site, on separate origins | Docker `.env`: `mainsite`, main-site issuer; share the Relay origin and signing secret with that site. |
| CFW site integrated with your main site | Worker + Durable Object + a compatible main site | Wrangler `vars`: `mainsite`, main-site issuer; store the shared signing secret as a Worker secret. |

The main site's deployment is independent too: a CFW Relay can use a main site
running on your own server, and a Docker Relay can use a main site on Workers.
They communicate over HTTPS, not through a shared database. See
[main-site API and data requirements](#main-site-api-and-data-requirements) before
selecting main-site login for an existing website.

Direct Google login needs no main site. Main-site login delegates authentication
to your own website, which must implement the API and data contract below.
Both configurations use your own site origins and credentials.

The following commands run from a source checkout on the deployment/build machine:

```sh
git clone https://github.com/xuangong/agent-remote-control.git
cd agent-remote-control
```

### Configure authentication

Choose one canonical HTTPS origin, such as `https://agents.example.com`, reachable
by both browsers and Controllers. Use an origin without a path, query or trailing
slash. Plain HTTP is supported only on loopback for local development.

Set these values for **either** deployment method:

| Setting | Value |
| --- | --- |
| `AGENT_REMOTE_RELAY_URL` | Your canonical site origin. |
| `AGENT_REMOTE_AUTH_PROVIDER` | `google` for direct Google login, or `mainsite` for main-site login. |
| `AGENT_REMOTE_SIGNING_SECRET` | The Relay's application signing key; generate once with `openssl rand -hex 32`. |

For Docker, place configuration and secrets in `deploy/self-hosted/.env`. For
CFW, put ordinary configuration in the private-deployment Wrangler template's
`vars` and supply secrets with `wrangler secret put`, as shown below. These are
server configuration choices, not browser settings. Preserve the signing secret
across restarts and upgrades; do not commit it or put it in client assets.

These credentials have different jobs: Google OAuth verifies the user's identity;
the email allowlist decides who may sign in; the Relay signing secret authenticates
browser-device identifiers and persisted Relay state. In Google mode, generate the
secret locally and keep it on the Relay. In main-site mode, the main site and Relay
share it for their signed authentication protocol. It is not a Google credential,
a model API key, or a Controller pairing key.

Caddy's TLS certificate protects HTTPS/WSS traffic. Its private key is managed by
Caddy and is separate from `AGENT_REMOTE_SIGNING_SECRET`. Certificate renewal does
not require changing the application secret. Preserve that secret with your Relay
backups: replacing it can make existing persisted state fail validation at startup.

**Google / Gmail login**

1. In your Google Cloud project, configure the OAuth consent screen/audience and
   create an OAuth client of type **Web application**. Add test users if your
   application is in testing mode.
2. Register the exact authorized redirect URI
   `https://agents.example.com/auth/callback`. If you use `workers.dev`, use that
   site's exact HTTPS origin instead. See [Google's OpenID Connect setup](https://developers.google.com/identity/openid-connect/openid-connect).
3. Add the following settings, using your own values:

```dotenv
AGENT_REMOTE_AUTH_PROVIDER=google
AGENT_REMOTE_GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
AGENT_REMOTE_GOOGLE_CLIENT_SECRET=your-private-client-secret
AGENT_REMOTE_GOOGLE_ALLOWED_EMAILS=you@gmail.com,colleague@example.com
```

The allowlist is required: use comma-separated, explicit Google account email
addresses, without wildcards or empty entries. Only verified emails are accepted;
matching is case-insensitive. Omit `AGENT_REMOTE_ISSUER` in Google mode. Website
login does not configure model API keys or sign in to native agent CLIs.

**Main-site login**

Select `AGENT_REMOTE_AUTH_PROVIDER=mainsite`. A main site is an account/login
authority that implements the contract below. The existing Gateway integration
is one implementation of this contract, not a required product or deployment.
The main site does not need to provide model APIs for authentication.

The old `gateway` configuration value is accepted as a compatibility alias for
`mainsite`; new deployments should use `google` or `mainsite` explicitly. Changing
only this name preserves existing login identities, Host bindings and stored
state. Existing endpoint names and JWT types containing `gateway` below remain
literal protocol identifiers.

On the Relay, replace the Google settings with:

```dotenv
AGENT_REMOTE_AUTH_PROVIDER=mainsite
AGENT_REMOTE_ISSUER=https://main.example.com
```

Configure the same `AGENT_REMOTE_RELAY_URL`, `AGENT_REMOTE_ISSUER` and
`AGENT_REMOTE_SIGNING_SECRET` on your main site and Relay. The main site must
implement the Agent Remote signed login and authority APIs; an arbitrary OAuth
server or OpenAI-compatible API endpoint is insufficient. See the
[main-site contract](#main-site-api-and-data-requirements) below and
[integration guide](docs/current/agent-remote/gateway-relay.md).
Our public site uses CFW + main-site login; private deployments select their own
combination explicitly.

**Where to sign in and which account to use**

- With **main-site login**, sign in to the main site first, then open Agent Remote
  from it or follow this site's sign-in flow back to the main site. If the main
  site uses Google, use the same Google/Gmail account you use there. The main site
  issues access for that logged-in account; the Relay does not perform a second,
  independent Google login or need a Google OAuth client of its own. A valid
  existing main-site login can be reused; expired or insufficient authentication
  requires signing in there again.
- With **direct Google login**, sign in to this site using an allowed Google
  account. There is no main-site account or login requirement.

Main-site login identifies the user by the main site's stable `iss` + `sub`, not
by matching Gmail addresses. Custom main sites can use other login methods if
they satisfy the same contract. Direct Google login uses a separate identity
namespace: using the same Gmail in both modes does **not** merge Host ownership,
permissions or stored state. Changing modes requires migration or re-enrollment.

### Deploy with Docker

Install Docker Engine with Docker Compose. Node, pnpm and built artifacts are not
required on the deployment machine: [Dockerfile.self-hosted](Dockerfile.self-hosted)
builds the application from source, using the Tencent npm mirror by default.

```sh
cp deploy/self-hosted/.env.example deploy/self-hosted/.env
chmod 600 deploy/self-hosted/.env
# Edit .env: set your site origin, chosen auth settings and real secrets.

docker compose --project-name my-agent-remote \
  --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml config --quiet
docker compose --project-name my-agent-remote \
  --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml up -d --build
docker compose --project-name my-agent-remote \
  --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml ps
```

Use the dedicated [Compose file](deploy/self-hosted/compose.yaml) and
[environment template](deploy/self-hosted/.env.example). The root Compose files
serve other development/integration workflows.

The service listens on **127.0.0.1:5910** on the Docker host. Set
`AGENT_REMOTE_HTTP_PORT` in `.env` if that port is occupied. Keep the container's
port private; browsers and Controllers connect through Caddy on your public domain.

#### Caddy and Let's Encrypt

Point the domain's DNS A record, and AAAA record if used, at this server. Allow
inbound TCP ports **80 and 443** to Caddy. The following example assumes Caddy runs
**on the Docker host**, with its Caddyfile at `/etc/caddy/Caddyfile`:

```caddyfile
{
    email admin@example.com
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}

agents.example.com {
    reverse_proxy 127.0.0.1:5910
}
```

Replace the domain and contact email. If a global `{ ... }` block already exists,
merge these options into it rather than adding a second block. `acme_ca` selects
Let's Encrypt for the sites using this global default. Caddy obtains and renews
certificates automatically and redirects HTTP to HTTPS; a separate Certbot process
is unnecessary. Keep the same public origin in all three places:

| Configuration | Example |
| --- | --- |
| Caddy site address | `agents.example.com` |
| Docker `.env` | `AGENT_REMOTE_RELAY_URL=https://agents.example.com` |
| Google authorized redirect URI | `https://agents.example.com/auth/callback` |

Validate and reload an existing host-installed Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
```

Caddy's HTTP upstream preserves the public `Host` and browser `Origin` and supports
WebSocket upgrades by default. Do not rewrite `Host` to `127.0.0.1`: Relay validates
it against `AGENT_REMOTE_RELAY_URL`. If you change the published HTTP port, update
the upstream port too. Existing WebSockets may reconnect when Caddy reloads.

If **Caddy also runs in Docker**, attach Caddy and `relay` to the same Docker
network and use `reverse_proxy relay:5910` instead. A Caddy container's
`127.0.0.1` refers to itself. Keep the Relay's internal port at 5910; the
`AGENT_REMOTE_HTTP_PORT` setting only changes the host-side port. Publish 80/443
from Caddy and persist its certificate data (`/data` in the official Caddy image),
separately from the Relay's state volume. The supplied Compose file runs Relay
only; it does not create or configure a Caddy container or their shared network.

Certificate renewal needs the validation route to remain reachable and Caddy's
data directory to remain writable. Preserve that directory during upgrades instead
of requesting new certificates on every restart. See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https),
[ACME configuration](https://caddyserver.com/docs/caddyfile/options#acme-ca) and
[reverse proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

Verify through the public address:

```sh
curl -fsS https://agents.example.com/health
```

Expect `{"status":"ok","service":"agent-remote-gateway-relay"}`. Open the site
and sign in before proceeding to Controller pairing. For startup failures, use
the same Compose options with `logs --tail=100 relay`.

### Deploy with Cloudflare Workers (CFW)

Use Node.js 22+ and pnpm **10.34.5**, and your own Cloudflare account. Edit
[deploy/self-hosted/wrangler.jsonc](deploy/self-hosted/wrangler.jsonc):

- Set `name` to your Worker name.
- Set `vars.AGENT_REMOTE_RELAY_URL` to
  `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev`, using your account's Workers
  subdomain. Register that same origin's `/auth/callback` in Google mode.
- Set the auth provider and its non-secret settings from the authentication
  section. The template starts in Google mode; for main-site login, remove the Google
  settings and add your `AGENT_REMOTE_ISSUER`.
- Keep `RELAY`, `RelayObject`, asset bindings and migration definitions intact.

Do **not** use `packages/agent-remote-cloudflare/wrangler.jsonc` for a private
deployment: it contains this project's production Worker name and domains.

```sh
pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm/
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler login
pnpm build:relay
pnpm --filter @orchardworks/agent-remote-cloudflare run build
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy \
  --config ../../deploy/self-hosted/wrangler.jsonc --dry-run

# Paste the previously generated signing secret when prompted.
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler secret put \
  AGENT_REMOTE_SIGNING_SECRET --config ../../deploy/self-hosted/wrangler.jsonc
# Google mode only: paste your Google OAuth client secret when prompted.
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler secret put \
  AGENT_REMOTE_GOOGLE_CLIENT_SECRET --config ../../deploy/self-hosted/wrangler.jsonc
pnpm --filter @orchardworks/agent-remote-cloudflare exec wrangler deploy \
  --config ../../deploy/self-hosted/wrangler.jsonc
```

Keep secret values out of `vars`. Skip the Google secret command for main-site login.
For your own domain instead of `workers.dev`, configure a Workers Custom Domain
on the template's `routes`, set `workers_dev` to `false`, and update the canonical
origin and Google redirect URI together. For example, the `routes` value is
`[{ "pattern": "agents.example.com", "custom_domain": true }]` for a domain in
your Cloudflare account. See [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).

Verify `https://YOUR-SITE/health`, open the site and sign in, then install and pair
Controller below. Workers use Durable Object storage; there is no Docker volume
or dependency on a main site's D1/KV/R2 bindings for this deployment.

### Keep data across upgrades

For Docker, keep the same Compose project name and `relay-state` volume mounted
at `/data`, along with the private `.env`. Rebuild and run `up -d --build` to
upgrade; do not run `down -v`. Back up the whole volume while this Relay is stopped,
and back up its matching configuration/secrets separately. Run only one Relay
process against that state.

For CFW, deploy to the same Worker and keep its Durable Object namespace, bindings
and migration history. A bundle backup is not a storage backup. Neither deployment
currently provides automatic cross-runtime state migration; changing auth
providers or identity configuration also requires a planned migration/re-enrollment.
Provider sessions and project files require separate backups on their Hosts.

See the [self-hosting operations guide](docs/self-hosted-deployment.md#persistence-backups-and-upgrades)
for backup/restore limits and [protocol upgrades](docs/protocol-upgrade-runbook.md)
before a release that also requires newer Controllers.

<a id="install-agent-host-as-a-standalone-command"></a>

## Install Controller

Run the following on **each agent/workstation computer**, not in the Relay
container. Install Node.js **22+** with npm and at least one supported native CLI
first. Authenticate that CLI locally. Controller detects supported Codex, Claude
Code, Copilot and OpenCode installations; DSH uses its separate Host plugin.

The repository-root installers are [install.sh](install.sh) for macOS/Linux and
[install.ps1](install.ps1) for Windows. The Relay build copies those scripts to
your site's `/install.sh` and `/install.ps1`; the download commands below use them.
Pass your site's `--server` / `-Server` explicitly so first installation does not
select the default public service.
Published releases currently list only macOS arm64, the platform they are tested
on, so the installers and remote updates refuse other platforms until releases are
tested there again (see [Controller releases](docs/controller-updates.md)).

The installer downloads a published Controller package from this project's
**GitHub Releases**, verifies its manifest/platform/Node compatibility and SHA-256,
then installs it locally. npm also needs network access for dependencies; the
commands below select the Tencent npm mirror. No source checkout or pnpm is
needed on the Host. This is a source-based private Relay deployment with a public
Controller distribution, not an offline installation bundle.

**macOS / Linux** — requires `sh`, `curl`, `tar` and SHA-256 tools:

```sh
curl -fsSL 'https://agents.example.com/install.sh' \
  | npm_config_registry=https://mirrors.cloud.tencent.com/npm/ \
    sh -s -- --server 'https://agents.example.com' --providers codex
```

**Windows PowerShell** — supports Windows PowerShell 5.1 and PowerShell 7, with
Node/npm, `curl.exe` and `tar.exe` available:

```powershell
$env:npm_config_registry = 'https://mirrors.cloud.tencent.com/npm/'
$installer = Invoke-RestMethod 'https://agents.example.com/install.ps1'
& ([scriptblock]::Create($installer)) -Server 'https://agents.example.com' -Providers codex
```

Replace **both** occurrences of the site URL with your deployment. Set
`--providers` / `-Providers` to an installed CLI, such as `claude`, `copilot` or
`codex`, or a comma-separated list. Windows `-Providers` currently accepts only
those three names; an installed OpenCode is discovered by Controller separately.
The installer defaults to `codex` and
checks the selected CLIs before first startup; Controller subsequently discovers
all supported installed providers. `--install-codex` / `-InstallCodex` optionally
installs a pinned Codex privately if it is missing. `--no-start` / `-NoStart`
installs Controller without starting or pairing it.

**Already have the source checkout on the workstation?** Run the root script
instead of downloading it. This still installs a published Controller release;
it does not build the checked-out source:

```sh
npm_config_registry=https://mirrors.cloud.tencent.com/npm/ \
  sh ./install.sh --server https://agents.example.com --providers codex
```

In PowerShell, from the repository root:

```powershell
$env:npm_config_registry = 'https://mirrors.cloud.tencent.com/npm/'
& ([scriptblock]::Create((Get-Content -Raw .\install.ps1))) -Server 'https://agents.example.com' -Providers codex
```

The script-block form works without changing PowerShell execution policy. Both
entry points use the same hidden pairing-key prompt as the hosted installer.

The installer prompts for the Host name and hidden pairing key, starts Controller
and waits for registration. Existing installations offer **Update**, **Clean
install** or **Cancel**; updating preserves the saved Host identity and site.
Installing/updating with another `--server` value does not replace an existing
pairing: use the explicit re-pair procedure below to change sites.

If the installer reports a missing PATH entry, add its printed command directory
to your user PATH (`~/.local/bin` by default on macOS/Linux). On Windows the default
is `%LOCALAPPDATA%\agent-remote-controller\bin`; its `.cmd` launcher can be used
without changing PowerShell execution policy. Verify with:

```sh
agent-remote-controller --version
agent-remote-controller status
```

For Controller **inside a separate agent container**, use the same installer in
that container with Linux-native CLIs and persistent home/state/workspace volumes.
It runs Controller in the foreground. Make `agent-remote-controller foreground`
the container's subsequent startup command and provide a restart policy. See
[Controller in Docker](docs/controller-install.md#inside-docker) for the complete
example; this is distinct from the Relay's Docker deployment above.

For a custom Controller source build, run `pnpm build:agent-remote-controller` in
the source checkout and install the generated `.tgz` under
`dist/agent-remote-controller/` with `npm install -g /path/to/package.tgz
--registry=https://mirrors.cloud.tencent.com/npm/`. See the
[installation guide](docs/controller-install.md) and [Agent Host CLI guide](packages/agent-host/README.md)
for platform requirements, startup services, updates and diagnostics.

For simultaneous desktop CLI and phone control of one Codex session, use the
[shared native runtime setup](docs/current/agent-remote/codex-shared-runtime.md).

### Pair Controller with your site

1. Open **your deployed site**, sign in, then open **Settings → Pair Agent Host**.
2. Choose **Host only** to preserve existing native provider credentials/settings.
   Google mode provides this choice. Main-site mode also shows **Gateway token +
   CLI setup**, without checking whether the main site implements its APIs.
   Use that optional choice only when those APIs exist and you want the supplied
   model configuration written to the Host.
3. Click **Generate pairing key**. Run the site's displayed installation command
   or the appropriate command above, then paste the key into the terminal's
   hidden prompt. Each invitation enrolls one Host; create a separate key for
   each machine. Do not put the key in a command argument or shared screenshot.
4. Check `agent-remote-controller status` for **`uplink: registered`**. In the
   website's Hosts/session browser, select this Host and a detected provider,
   then open an existing session or create a new one in an allowed workspace.

Controller stores the site and device credential in its private local state
directory. Later starts use `agent-remote-controller start` with no new key.
The Host connects outbound to your site's HTTPS/WSS endpoint; no inbound port
on the workstation is needed. Use **Settings → Hosts → Agent providers** to
disable providers intentionally or request **Detect again** after installing one.

**Already installed, or switching a running Host to another site**

The CLI uses `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY` together; `--server`
and `-Server` above are **installer** options. To intentionally replace a running
Host's current uplink, generate a key on the destination site and run in Bash:

```bash
export AGENT_HOST_SERVER=https://agents.example.com
read -rsp 'Pairing key: ' AGENT_HOST_REMOTE_KEY; printf '\n'
export AGENT_HOST_REMOTE_KEY
agent-remote-controller pair
unset AGENT_HOST_REMOTE_KEY AGENT_HOST_SERVER
agent-remote-controller status
```

In macOS zsh, replace the `read` line with
`read -rs 'AGENT_HOST_REMOTE_KEY?Pairing key: '; printf '\n'`.
For a stopped or freshly installed unpaired Host, use `start` instead of `pair`.
Keep the same `AGENT_HOST_STATE_DIR` as the installation. For scripted enrollment,
the installers support `--key-file` / `-KeyFile` with a private key file.

There is currently **one active site per Host state directory**, not simultaneous
multi-site pairing. `pair` replaces the uplink while retaining native sessions;
it does not add a second site. Do not delete Controller state to perform an
ordinary restart or update.

| Symptom | Check |
| --- | --- |
| Google rejects the callback | OAuth client type, exact site `/auth/callback` URI, audience/test users and email allowlist. |
| Docker is healthy but the site cannot connect | Public DNS/TLS, forwarded `Host`/`Origin`, WebSocket upgrades and streaming proxy settings. |
| Controller runs but is not registered | Destination site URL, invitation validity and `agent-remote-controller diagnostics --source controller --limit 30`. |
| Host is online but a provider is missing | CLI installation/version, native login, Host provider settings and **Detect again**. |
| Installation/update cannot download | Host access to GitHub Releases **and** npm; changing the npm mirror does not proxy GitHub downloads. |

## Shared Window workspaces

A Window is a workspace with its own identity, independent of any session.
The product restores an existing Window on reopen; it creates one only when none
exists or when you choose **New Window**. No naming or save step is required.
Cached layouts appear before synchronization completes, and local edits apply
immediately while saving continues in the background.

A Window can contain multiple top-level sessions, attached subagents, and docked
or floating views. Click a view's title, conversation, or composer to select it;
sidebar, Favorites, Track, and new-session actions target that selected ordinary
view. **New session view** creates an empty dock that can be bound afterward.
Ask, Team, and TPM views keep their managed bindings. The selected session is
also the source for creating related Ask, Side, Team, or TPM work.

Open a Window's shared link in multiple pages to share layout, selection, docking,
widths, and per-view display preferences. Narrow screens show the selected view
without replacing the saved wide-screen layout. Every pane can be closed;
closing the last leaves the same empty Window. Closing a view does not stop its
native session or archive a Team or TPM task.

Use the floating **Window** button to switch Windows and select their session
views. Drag the button to reposition it; **View → Window view** shows or hides
the entry without changing the layout. Delete an inactive Window directly from
its list row; switch or create another Window before deleting the current one.
Other pages showing a deleted Window ask you to choose another without creating
a replacement. Deletion requires a valid active Window on the current page;
open or create one first if the current Window is unavailable.
**Window options** contains rename, copy link, and Agent control. Assign
one managing Agent session and download its private grant file to enable
`agent-remote-controller window ...`. These commands use the same committed
operations as the page; Host pairing credentials are not Window credentials.
See [Window Agent operations](docs/guides/window-agent-operations.md) for commands,
permission scope, explicit results, and recovery after a lost response.

## Main-site API and data requirements

Here, **main site** means the account/login authority at `AGENT_REMOTE_ISSUER`.
It can retain its own login methods and database. To integrate an existing site,
implement the main-site contract below; setting its URL alone does not add these
APIs. Google mode bypasses this integration completely.

A qualifying main site must own stable user identities and revocable login
sessions, issue signed Relay login tickets, answer Relay renewal/account-status
requests, and authenticate those service requests. Disabling an account or
revoking a login must affect those checks. Host sharing and model-key issuance
are optional extensions; neither a model proxy nor a particular main-site
framework, database or Google login implementation is required.

**Required login and authority APIs**

The Relay starts login by creating a five-minute browser-bound challenge and
redirecting to the main site. The main site authenticates its own user, issues a
Relay-specific ticket, and returns the browser to the Relay. Agent traffic then
flows directly between browser, Relay and Host.

| Main-site endpoint | Caller and input | Required behavior/output |
| --- | --- | --- |
| `GET /agent-remote` | Browser; query `challenge`, optional `host`, optional `reauthenticate=1` | Authenticate an enabled user. Preserve the validated challenge/Host through login. Without a challenge, redirect to the configured Relay's `/auth/login` to obtain one. `reauthenticate=1` must perform a real authentication step. |
| `POST /api/agent-remote/launch` | Main-site authenticated browser; JSON or form `{challenge, host?}` | Recheck the user/login, bind the ticket's `nonce` to the 43-character base64url challenge, then redirect a form caller with 303 to `RELAY/auth/callback?host=...#ticket=...` (omit `host` when absent). JSON callers receive `{launchUrl, expiresAt}`, with `expiresAt` an ISO date string. The browser launch page can submit this endpoint automatically. |
| `POST /api/agent-remote/renew` | Relay service proof; JSON `{continuation}` | Check the original login still exists, is unexpired/unrevoked, belongs to the same user, and that user is enabled. Return `{active:true, subject, expiresAt, validUntil, authenticatedAt, profile?}`. |
| `POST /api/agent-remote/user-status` | Relay service proof; JSON `{subject}` | Check the account independently of any browser login. Return `{active:true, subject, validUntil}` for an enabled account. This keeps Hosts paired when a browser logs out. |

The launch endpoint's authentication belongs to the main site, which can use its
own login session format. Model API keys are not browser login evidence. Authenticate the caller
server-side; do not accept a user ID supplied by the browser as its identity.
Cookie-based launch requests require the exact main-site `Origin`; reject foreign
origins and arbitrary callback/return URLs. Keep the callback at the configured
Relay origin and carry the ticket in the URL **fragment**, not the query string.

The ticket is an HS256 JWT with the exact header
`{"alg":"HS256","typ":"arc-relay+jwt"}` signed with the shared secret:

| Claim | Meaning |
| --- | --- |
| `iss`, `aud` | Exact main-site origin and Relay origin, respectively. |
| `sub` | Stable account ID; use 1–256 characters to fit login, authority and sharing APIs. Never an editable display name. |
| `nonce` | The unchanged Relay challenge, not a main-site-generated replacement. |
| `jti` | Unique non-empty ticket ID, at most 128 characters. |
| `iat`, `exp` | Integer Unix **seconds**. Ticket lifetime must be positive, at most 900 seconds, and not exceed the original login expiry. |
| `continuation` | Opaque, revocable handle for the original login, at most 6000 characters. Include it for renewable access. |
| `sessionExpiresAt` | Original login expiry in Unix **milliseconds**; include together with `continuation`. |
| `authenticatedAt` | Actual credential-verification time in Unix **milliseconds**. Preserve it during launch and renewal; do not replace it with the current time. |

The Relay validates and consumes the browser challenge, then calls `renew`
before creating renewable browser access. A signed ticket alone is insufficient
for the full experience. `authenticatedAt` is needed for sensitive operations;
legacy sessions without that evidence must reauthenticate rather than invent it.
The optional renewal `profile` is `{name, email?}` for display only.

For `renew` and `user-status`, `validUntil`, `expiresAt` and `authenticatedAt` use
Unix **milliseconds**. Return a short authority lease (`validUntil` no later than
now + 120 seconds, also capped at login expiry for `renew`). The returned subject
must agree with the original grant/request. Use **401/403** for expired, revoked
or disabled access and **503** for temporary authority/storage failure. A 200
response with `active:false` is not a denial response in this protocol. The Relay
uses a five-second request deadline, does not follow redirects, and treats
malformed responses/network errors as unavailable rather than renewing access.
While the authority is unavailable, access it last confirmed stays usable for up to
15 minutes after that confirmation, so a short authority outage does not disconnect
Hosts and browsers; a 401/403 still ends access immediately. Set
`AGENT_REMOTE_AUTHORITY_OUTAGE_GRACE_MS` (0 to 3600000) on the Worker to change
that window; 0 restores the previous behaviour of ending access with the lease.

Server-to-server requests carry `Authorization: Bearer <proof>` and JSON with no
browser Cookie or Origin. Verify HS256 with exact JWT header
`{"alg":"HS256","typ":"arc-relay-service+jwt"}` and claims:

```text
iss = Relay origin
aud = main-site origin
op = renew | user-status | host-key | revoke-host-key
bodyHash = base64url(SHA256(exact UTF-8 request body bytes))
iat, exp = integer Unix seconds; lifetime at most 60 seconds
```

Validate signature, direction, operation, body hash and expiry. Do not reuse the
browser-ticket verifier for service proofs. Return authentication/key responses
with `Cache-Control: no-store`. The Relay sends no service-proof `jti` in this
direction; downstream key mutations must be idempotent by their business identity.
The shared secret grants mutual service trust; keep both sites in your trusted
administrative boundary.

**Optional main-site features**

| Feature | Additional APIs and behavior |
| --- | --- |
| Main-site Host list and sharing UI | Implement authenticated `GET /api/agent-remote/hosts`, `GET /api/agent-remote/hosts/:hostId/shares`, `PUT` on that shares path with `{email, sessionLimit}`, and `DELETE` with `{email}`. Resolve emails to canonical user IDs server-side. |
| Forward sharing operations to Relay | Your backend calls the **Relay's** `POST /gateway/control` with `{subject, operation, hostId?, targetSubject?, targetLabel?, sessionLimit?}`. Operations are `hosts`, `shares`, `share`, `revoke-share`; this endpoint is not hosted by the main site. |
| Model key + CLI setup (currently labeled **Gateway token + CLI setup** in the UI) | Implement `POST /api/agent-remote/host-key` with `{subject, hostId, hostName}` and operation-bound Relay service proof. Return `{apiKey, keyId, baseUrl, model}`, with `baseUrl` exactly `AGENT_REMOTE_ISSUER + "/v1"`. For this optional feature, your main site must also provide the model API and usable upstream credentials at that address. |
| Revoke an issued Host model key | Implement `POST /api/agent-remote/revoke-host-key` with the same identity body and matching proof operation; return `{ok:true}` idempotently, including when no key exists. Persist revocation so a delayed/repeated issuance cannot resurrect the key. |

For main site → Relay control, use a separate HS256 header
`typ=arc-gateway-service+jwt`, reverse `iss`/`aud`, set `op=control`, and include
the exact `bodyHash`, `iat`, `exp` (at most 60 seconds) and a fresh `jti` of
16–128 characters. Relay rejects replayed proofs and enforces Host ownership.
Use the main site's user session and same-origin checks for browser mutations;
share creation/editing requires authentication within ten minutes. Resolve the
recipient from your live account store and keep session creation limits within
0–10000. Grants and cumulative usage are stored by Relay; revoking/regranting a
share does not reset usage. See [sharing semantics](docs/current/agent-remote/gateway-relay.md#shared-hosts-and-session-creation-allowance).

An authentication-only main site can support **Host only** with the required
login/authority APIs and leave native model credentials on Hosts. However, current
`mainsite` mode advertises model-key setup/control capabilities without probing each
main-site endpoint; there is no separate environment switch to hide them. A partial
integration must document unsupported features and use Host only. Full main-site
feature parity requires the optional endpoints as well; returning a fabricated
key or unconditional success is not a valid substitute.

**Data the main site must retain**

| Data | Required guarantees |
| --- | --- |
| Accounts | Stable, non-recycled subject ID; enabled/disabled state; display name and optional email. Sharing additionally needs canonical email-to-user lookup. |
| Login sessions | User binding, stable session identity, expiry, revocation and original credential-verification time. Renewal must query this authoritative state, not merely decode an old ticket. |
| Continuations | Unguessable handle mapped to original session identity, user, issuer, Relay audience, expiry and authentication time. Store a hash of the handle; revoke it when the original session is removed. Recreating a login must not revive old handles. The reference implementation uses `arc2_` plus 32 random bytes encoded as base64url; Relay treats it as opaque. |
| Authentication challenges | Your own OAuth/reauthentication state, browser binding, expiry and one-time consumption when those flows are used. The Relay independently stores its own launch challenge; never replace that challenge with your OAuth state. |
| Optional Host model keys | Unique binding `(owner subject, Relay origin, Host ID)`, credential/key ID, atomic issuance and durable revocation tombstone. Concurrent/repeated requests reuse the key; a revoked binding cannot silently issue a replacement. |
| Deployment trust | Canonical issuer/Relay origins and shared signing secret in your runtime secret store. Preserve these with backups and planned migrations. |

These are data semantics, not mandatory SQL table names or a database product.
The main site does not need a copy of Relay's Host bindings, browser cookies,
pairing keys, Team/TPM state, shares or usage ledger. Relay owns that application
state in its volume/Durable Object. Native session history and workspaces remain
on the Hosts; transcript traffic does not pass through the main site.

Implementation references: [ticket validation](packages/agent-remote-hosted/src/auth.ts),
[authority requests](packages/agent-remote-hosted/src/authority.ts),
[browser-session renewal](packages/agent-remote-hosted/src/sessions.ts),
[sharing control](packages/agent-remote-hosted/src/control.ts) and
[Host-key setup](packages/agent-remote-hosted/src/host-bootstrap.ts).
Before enabling a custom main site, verify login/callback, expiry/logout, disabled
users, authority outages and recovery, and Host pairing/reconnect against both
services. Exercise sharing and key revocation too if you expose those features.

## Run locally

Use Node 22 or later and pnpm 10.34.5. All commands run from this repository root.

To build and start the complete controller with Codex, Claude, and DSH:

```bash
pnpm start --codex /absolute/path/to/codex --claude /absolute/path/to/claude \
  --dsh /absolute/path/to/dsh
```

The launcher builds Agent Host and Web, installs the DSH Host plugin, starts both native Hosts, pairs them automatically, and prints the controller URL after all three providers are ready. Keep the terminal open; Ctrl+C stops this environment. Use `pnpm start --config .runtime/controller.json` for repeatable configuration, or `--dsh-repo` for a DSH source checkout. See the [complete startup guide](docs/runbooks/controller-start.md) for profiles, ports, configuration, and lifecycle.

The local diagnostic workbench has no account system. Its pairing keys are
temporary and process-local. Chat, questions, approvals, Timeline, Trace, and
Replica Inspector use the same public session protocol as the product.

To start only that workbench and pair Hosts manually:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Open `http://127.0.0.1:6175`. The default server at `http://127.0.0.1:5910` owns the labeled Recorded fixture and the Agent Host pairing broker. Native Codex, Claude Code, and Copilot run only in the independent Agent Host. Existing listeners are not replaced; choose free ports with `AGENT_REMOTE_PORT` and `AGENT_REMOTE_WEB_PORT` when needed. `AGENT_REMOTE_BIND` can expose the broker on an explicit interface; local management authorization remains unchanged.

The scoped npm registry in `.npmrc` resolves the pinned DSH prerelease packages through the Tencent mirror. The lockfile pins the dependency graph. Native DSH services target `0.1.2-rc.1`; the Codex fixture targets `codex-cli 0.162.0`. Provider constraints and supported degradations are recorded in [compatibility.json](packages/agent-remote-lab/compatibility.json). The [Provider support baseline](docs/current/agent-remote/provider-support.md) compares DSH, Codex, Claude and Copilot, including endpoint gaps, verification and workarounds; use its [onboarding checklist](docs/current/agent-remote/provider-onboarding.md) for a new Provider.

## Connect a real Codex CLI

Start the workbench, open **Pair Agent Host**, and generate a temporary key. In another terminal, start Codex through the Host:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_CODEX=/absolute/path/to/codex
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
pnpm agent-remote-controller start
```

Select **Codex · <Host name> · Online** in Session intake. The verified CLI version is `0.148.0`; older versions are rejected with an actionable message. `AGENT_REMOTE_CODEX_HOME`, `AGENT_REMOTE_CODEX_EXECUTABLE`, and `AGENT_REMOTE_WORKSPACE` remain supported aliases. See [Codex installation and debugging](docs/runbooks/codex-debug.md) for an isolated Tencent-registry install and the process/session boundaries.

## Connect Claude Code and other native providers

Start the workbench and generate a temporary key through **Pair Agent Host**. For a custom Claude installation:

```bash
export AGENT_HOST_SERVER=http://127.0.0.1:5910
export AGENT_HOST_REMOTE_KEY='paste-the-generated-key'
export AGENT_HOST_CLAUDE=/absolute/path/to/claude
export AGENT_HOST_WORKSPACE=/absolute/path/to/workspace
pnpm agent-remote-controller start
```

Select **Claude Code · <Host name> · Online**. Claude Code must be version `2.1.247` or newer; the adapter pins `@anthropic-ai/claude-agent-sdk` to `0.3.247`. Controller automatically detects supported providers at startup and every minute; unavailable installations do not prevent Host startup. Use **Settings → Hosts → Agent providers** for persistent per-Host opt-outs. Executable overrides such as `AGENT_HOST_CODEX` remain supported.

`AGENT_HOST_CLAUDE_HOME` selects an optional native profile through `CLAUDE_CONFIG_DIR`. Native authentication and settings remain owned by Claude Code. See [Claude installation and debugging](docs/runbooks/claude-debug.md) for isolated installation, configuration, session lifetime, and supported controls. Use a different `AGENT_HOST_STATE_DIR` when keeping an existing daemon running alongside a separate Host.

## Connect GitHub Copilot through its official SDK

Copilot is opt-in: `pnpm start --providers copilot` uses the pinned installed CLI; pass `--copilot /absolute/path/to/copilot` to override. For a manually paired Host, set `AGENT_HOST_SERVER`, `AGENT_HOST_REMOTE_KEY` and `AGENT_HOST_WORKSPACE`, then run `pnpm agent-remote-controller start`. `AGENT_HOST_COPILOT` overrides the executable and `AGENT_HOST_COPILOT_HOME` selects the native profile. The Host discovers compatible native providers automatically.

The adapter uses official `@github/copilot-sdk` **1.0.11** and Copilot CLI **1.0.83**, through SDK stdio. It does not use ACP. Authentication remains in the native CLI profile/environment. Real SDK/CLI tests use an isolated local model endpoint, without cloud prompts. See the [Copilot audit](docs/current/agent-remote/copilot-support-audit.md) for supported input, history, parent-owned children, experimental APIs and remaining gaps. Run `pnpm test:copilot` for the bounded adapter and native loopback suite.

## Connect a real DSH installation

Run the guided setup from the repository root. It installs the Host plugin, generates a temporary key, starts DSH, and checks Host registration and Web readiness:

```bash
node scripts/dsh-debug.mjs
```

For a source installation, pass `--dsh-repo /path/to/deepseek-harness`. Add `--build-dsh` to install its dependencies and build its official runtime artifacts. An installed CLI can be selected with `--dsh /path/to/dsh`. The default DSH home is isolated under `.runtime/dsh-debug/home`. See the [guided DSH debugging runbook](docs/runbooks/dsh-debug.md) for first-run setup, repeatable commands, ports, and troubleshooting.

For manual installation:

Build the independent outbound Host plugin:

```bash
pnpm --filter @orchardworks/dsh build:bundle
```

The archive is `packages/agent-remote-dsh/dist/host-bundle/orchardworks-dsh-host-0.1.0.tgz`. Install it into a compatible DSH Web profile using the DSH CLI associated with that installation:

```bash
dsh plugin --profile web add "file:$(pwd)/packages/agent-remote-dsh/dist/host-bundle/orchardworks-dsh-host-0.1.0.tgz"
```

In the workbench, generate a temporary key. Start DSH Web with its existing home and workspace so its native session catalog remains available:

```bash
export AGENT_REMOTE_SERVER_URL="http://127.0.0.1:5910"
export AGENT_REMOTE_ACCESS_KEY="paste-the-generated-key"
export AGENT_REMOTE_INSTANCE_NAME="My DSH"
dsh --profile web --host 127.0.0.1 --port 3081
```

The plugin also accepts Cordis configuration fields `serverUrl`, `remoteKey`, and `instanceName`. Each advertised Provider appears in the workbench selector as `<Provider name> · <Host name> · Online/Offline`, alongside the labeled Recorded fixture. Selecting it switches session discovery and workspace selection to that installation. Choose a workspace and click **Open session**, or select an existing session from the directory. Offline Hosts remain visible, with creation disabled; another Provider can still be selected. The native DSH installation continues to own model selection, credentials, persistence, and approval services.

Keys are valid for new connections for 24 hours and bind to one installation. Established connections remain active after key expiry until they disconnect. Restarting the backend clears temporary keys and host bindings. A background Host can keep native sessions alive: generate a new key, set `AGENT_HOST_SERVER` and `AGENT_HOST_REMOTE_KEY`, then run `pnpm agent-remote-controller pair` to replace only its uplink. Host reconnection within the same backend process restores session bindings on demand without replaying message submissions or uncertain creation requests.

## Development and verification

```bash
pnpm verify          # compatibility check, build, typecheck and unit tests
pnpm test:local      # native CLI suites that need this machine's signed-in agents
pnpm test:conformance
pnpm test:e2e
pnpm lint:docs
```

There is no hosted CI. Run `pnpm hooks:install` once per clone so every branch push runs `pnpm verify` through `.githooks/pre-push`; tag-only pushes skip it. The unit suite (`pnpm test`) excludes `*.local.test.ts` files and must pass on any machine; `pnpm test:local` runs those native suites one package at a time.

Test scripts enforce per-test and outer process deadlines. Browser tests use separate configurable ports and refuse to reuse an existing server. Set `AGENT_REMOTE_TEST_RELAY_PORT` and `AGENT_REMOTE_TEST_WEB_PORT` to free ports for concurrent testing. Run `pnpm compatibility:update` after source changes, then `pnpm compatibility:check` to verify the declared implementation digest.

The root test runner probes each selected native executable with a five-second `--version` deadline before starting native suites. It reports the resolved path, actual version and test baseline. Local native tests require `BORGEE_CODEX_TEST_EXECUTABLE` to name an explicit absolute executable whose complete version output matches the Lab compatibility manifest (currently `codex-cli 0.162.0`). `BORGEE_AGENT_REMOTE_COMPATIBILITY_MANIFEST` selects an alternative manifest, resolving relative paths from the Lab package. Shared and optional Codex native suites require 0.162.0+ instead. Claude Code requires 2.1.247+ and uses `AGENT_CLAUDE_TEST_EXECUTABLE` or `PATH`. Copilot requires 1.0.83+, uses its installed package entry, and reports the package version separately because its native cache can select a newer runtime. Explicit OpenCode native suites require 2.x at 2.0.25+, while existing evidence experiments retain their exact-version requirements. These are test prerequisites, not product compatibility guarantees; fixture-only suites do not acquire native dependencies. `pnpm test:setup` includes the preflight behavior tests.

`pnpm dev` runs the Recorded-backed workbench and pairing broker. `pnpm agent-remote-controller start` starts the selected native providers in the managed Host daemon so a later `pnpm agent-remote-controller pair` can replace its uplink without stopping native sessions. `pnpm agent-remote-controller foreground` is an attached debugging mode without daemon pairing control. `pnpm dev codex-fixture` remains a clearly labeled direct fixture composition for adapter validation; `pnpm dev recorded` runs the Recorded fixture and broker. The optional DSH fixture launcher and installed-release preparation tools remain documented in the [Lab guide](packages/agent-remote-lab/README.md).

## Package boundaries

| Package | Owns |
| --- | --- |
| `agent-provider-sdk` | Native-independent session and observation contract. |
| `agent-provider-dsh`, `agent-provider-codex` | Native provider interpretation and runtime adapters. |
| `agent-remote-protocol` | Public schemas, codecs, versioned uplink envelopes, and contract fixtures. |
| `agent-remote-relay` | Session execution, ordered public state, transport, and uplink clients. |
| `agent-remote-web` | Browser transport, recovery, replica, and reusable React DOM rendering. |
| `agent-remote-debugger` | Headless Session View protocol/state debugging and scripted regression through `ardb`. |
| `agent-remote-dsh` | Native catalog, shared-session setup, and independent DSH Host bundle. |
| `@orchardworks/agent-remote-lab` | Workbench, local server, pairing broker, directory, and validation fixtures. |

All workspace packages use the `@orchardworks` scope. The standalone DSH runtime uses `@orchardworks/dsh`; its installable profile bundle is `@orchardworks/dsh-host`.

See the [product design](docs/blueprint/agent-remote-observation.md), [architecture map](docs/current/agent-remote/README.md), and [source and license notices](NOTICE.md).

## Session View debugger

The `ardb` (Agent Remote Debugger) CLI is included in `packages/agent-remote-debugger`. It uses the same public HTTP/WebSocket protocol as the browser, including sessions attached through a paired DSH Host. It is the headless Session View, supporting protocol/state debugging and scripted non-rendering regression; session management, diagnostics and security in the surrounding product support that core view. `ardb server` starts a local Relay and serves the same product Timeline and Chatbox; CLI controls are streamed to subscribed views through normalized Agent state. See the [command and capability guide](packages/agent-remote-debugger/README.md).

```bash
pnpm ardb server --provider codex --cwd /path/to/workspace --open
pnpm ardb provider list --json
pnpm ardb inspect AGENT_ID --json
pnpm ardb timeline AGENT_ID --tail 20 --json
pnpm ardb send AGENT_ID "Hello" --json
pnpm ardb protocol trace AGENT_ID --jsonl --until idle --timeout 10000
```

Use the public Relay Agent ID, which is distinct from the native CLI session ID. `--relay` and `--origin` override the standalone defaults `http://127.0.0.1:5910` and `http://127.0.0.1:6175`. Environment settings are `AGENT_REMOTE_URL` and `AGENT_REMOTE_ORIGIN`. `ardb --help` lists server, creation, resume, observation, steer, cancel, planning, settings, interaction, resource, and wait commands.

The live Codex process tests require `codex-cli 0.162.0`. See the [Codex debugging guide](docs/runbooks/codex-debug.md) for isolated test installation and configuration.

Optional main-site integration: see [Main-site authentication](docs/current/agent-remote/gateway-relay.md) for login, Host sharing and cumulative session allowances.
[Agents deployment](docs/current/agent-remote/deployment.md) covers the independent
`agents.xianliao.de5.net` Worker, SSH Docker and local Node/workerd Docker profiles.

### OpenCode

OpenCode is available as a shared HTTP/SSE provider for Controller and ARDB. See [OpenCode setup and capabilities](docs/opencode.md).
