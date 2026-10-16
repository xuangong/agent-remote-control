# Local devbox

The devbox is a minimal trial and development environment: one Docker container
runs the web application, Relay, Controller, Codex, Claude Code, GitHub Copilot
and OpenCode. The web application and Controller are built from the same source
checkout. Open it before deploying a branch to exercise real session behavior.

The devbox uses one local user and signs the browser in automatically. Its
Controller enrolls automatically. Google, a main site, a domain, and production
pairing keys are not required. This local-user entry point is specific to the
devbox; the regular self-hosted deployment retains its configured authentication.

## Start

Install Docker with Compose 2.24 or newer, obtain this repository, then run from
the repository root:

```sh
docker compose -p arc-devbox -f deploy/devbox/compose.yaml up --build -d
docker compose -p arc-devbox -f deploy/devbox/compose.yaml logs -f
```

Open **http://localhost:5910**. The first build downloads dependencies and all four
native CLIs. Model sign-in is not required to start the website or register the
Host. An available native installation does not mean it is signed in or ready to
make a model request; configure the providers you want to try.

Common same-port loopback addresses, such as `http://127.0.0.1:5910`, work without
redirecting to another hostname. The server normalizes these explicitly accepted
addresses internally while retaining one persisted site identity.

You can also register this port with an authenticated Agent Remote Control local
preview and open its dedicated preview subdomain in a new browser tab. The outer
site still controls preview access; the devbox requires no second sign-in. Its
`devbox_*` cookies remain separate from the outer site's authentication cookies,
and HTTP requests and WebSockets use the same preview route. Idle Window change
polls return within 10 seconds to stay below the preview's response deadline.
Legacy `/p/<id>/`
path previews and embedding the complete devbox in an iframe are not supported.

The default npm registry is `https://mirrors.cloud.tencent.com/npm/`. Override
`NPM_REGISTRY` when building if another registry is required. Model API traffic
does not use this npm setting.

The HTTP port is published only on the Docker host's loopback interface. Do not
publish this automatically authenticated environment on a public address. Use
[self-hosted deployment](self-hosted-deployment.md) for an authenticated shared site.

If Node and pnpm are installed on the host, this optional shortcut also records
the checkout's Git revision and dirty state in the built Controller:

```sh
pnpm devbox up --build -d
pnpm devbox logs -f
```

Pure Docker builds require no host Node or pnpm. Without explicit
`DEVBOX_SOURCE_REVISION` and `DEVBOX_SOURCE_DIRTY`, they label the Controller as a
dirty source snapshot with the all-zero revision. That value means the archive
has no attached Git identity; it is not a release commit.

## Authenticate native providers

Open a shell as the container's regular `node` user:

```sh
docker compose -p arc-devbox -f deploy/devbox/compose.yaml exec devbox bash
```

Use each native CLI's normal login flow in this shell. Login data and session
history live in the persistent container home; they are not taken from the host's
personal account. `codex`, `claude`, `copilot` and `opencode` are all on PATH.
The installed CLI baselines expose these login commands:

| Provider | Command inside the container |
| --- | --- |
| Codex | `codex login --device-auth` |
| Claude Code | `claude auth login` |
| GitHub Copilot | `copilot login --device-code` |
| OpenCode | `opencode auth login --server http://127.0.0.1:4096` |

Follow the native CLI's printed instructions in your browser. Device-code flows
do not require exposing an extra callback port from the container. Provider login
and model calls are separate from the website's automatic local access.

The Controller wrappers also select the same configured native installations:

```sh
agent-remote-controller codex --help
agent-remote-controller claude --help
agent-remote-controller copilot --help
agent-remote-controller opencode --help
```

If a provider uses environment-based credentials, put the required variables in
`deploy/devbox/devbox.env` and recreate the container. This optional file is read
only at runtime and excluded from the image's build context. Keep it private and
do not commit it. `DEVBOX_ENV_FILE` can select another private file instead.
For Codex's built-in OpenAI provider, setting `OPENAI_API_KEY` alone is not the
same as native login: after starting with that environment variable, run
`printenv OPENAI_API_KEY | codex login --with-api-key` inside the container.

Provider authentication remains native: installing the box does not grant a
subscription or API access. Real model requests use the selected provider's
account and may incur its normal usage charges.

The OpenCode callback plugin is generated from the installed Controller at every
start, before its managed server starts. Ask and other Host callback features
therefore use this branch's plugin. Its process rendezvous is temporary; native
history and session references remain persistent.

## Workspace and saved state

The default working directory is `/workspace`. Clone or copy a disposable test
project there from the container shell, then create a session in the browser.
The container runs without root and does not mount the host filesystem or Docker
socket. Docker is the isolation boundary: this image explicitly enables trusted
Host control so agents can operate the container's writable files and the UI can
exercise native permission settings. If you add host directory mounts, those
files become part of the access you grant to the devbox.

To work on a host checkout, create `deploy/devbox/workspace.local.yaml` with an
absolute directory of your choice, then include it as a Compose override:

```yaml
services:
  devbox:
    volumes:
      - /absolute/path/to/test-project:/workspace
```

```sh
docker compose -p arc-devbox -f deploy/devbox/compose.yaml -f deploy/devbox/workspace.local.yaml up --build -d
```

This replaces the workspace volume with that directory. Changes made by agents
are visible on the host; the directory must be writable by the container's
`node` user (UID 1000). Keep using the same override when recreating the container.

Three named volumes are retained across rebuilds and ordinary shutdowns:

| Volume | Container path | Contents |
| --- | --- | --- |
| `devbox-data` | `/data` | Relay account, Window layouts, Host identity, pairing credential, TPM and Team state |
| `devbox-home` | `/home/node` | Native provider profiles, login state, histories and session references |
| `devbox-workspace` | `/workspace` | Projects and files created by agents |

The Controller reuses its accepted device credential after a restart instead of
creating or reusing an expired one-time invitation. The local site identity is
also persistent. Use a separate Compose project and volumes when selecting a
different port; existing state intentionally refuses a changed site origin.

```sh
DEVBOX_PORT=5911 docker compose -p arc-devbox-other -f deploy/devbox/compose.yaml up --build -d
# Optional pnpm equivalent:
DEVBOX_PORT=5911 DEVBOX_PROJECT=arc-devbox-other pnpm devbox up --build -d
```

## Rebuild, inspect and stop

After changing source, run the same `up --build -d` command. It rebuilds the web
application and Controller together and replaces the container while preserving
the three volumes. Rebuilding can interrupt active model tasks; finish a test
before replacing its environment. Use image rebuilds to update this devbox,
so the webpage and Controller continue to represent the same source tree. The
supervisor starts the installed CLI directly, without the release-update launcher;
this devbox does not advertise website-managed Controller updates.

```sh
docker compose -p arc-devbox -f deploy/devbox/compose.yaml ps
docker compose -p arc-devbox -f deploy/devbox/compose.yaml exec devbox agent-remote-controller status
docker compose -p arc-devbox -f deploy/devbox/compose.yaml exec devbox agent-remote-controller diagnostics --source controller --limit 60
docker compose -p arc-devbox -f deploy/devbox/compose.yaml down
```

Health checks require both a responding webserver and a registered Controller.
They do not submit a prompt or claim that all four provider accounts work.
Docker's init process and the devbox supervisor handle shutdown; no systemd,
launchd or host login service is installed. Stopping the container stops its
native runtime processes. `down` preserves the named volumes; deliberately add
`--volumes` only when you want to erase this devbox's projects, sessions and logins.

The image defaults to Codex `0.162.0`, Claude Code `2.1.247`, Copilot `1.0.83`, and
OpenCode `2.0.25`. Build arguments of the corresponding names
(`CODEX_VERSION`, `CLAUDE_VERSION`, `COPILOT_VERSION`, `OPENCODE_VERSION`) allow
explicit alternate versions with `docker build`. With Compose, use the prefixed
environment variables `DEVBOX_CODEX_VERSION`, `DEVBOX_CLAUDE_VERSION`,
`DEVBOX_COPILOT_VERSION`, and `DEVBOX_OPENCODE_VERSION`. Native automatic updates
are disabled so a running test environment does not silently change these targets.
At startup, the devbox sets `updater.autoUpdateEnabled=false` in the selected Codex
profile's `app-server-daemon/settings.json`, preserving its other settings. Invalid
settings are reported without replacing the file. Claude, Copilot, and OpenCode
use their native automatic-update environment switches. Rebuild the image to
change versions deliberately.

Before starting the Controller, an existing Codex managed runtime is compared
with the image's CLI. A different version is replaced through native
`codex app-server daemon update --from-cli --yes`, then read back to confirm the
match. A fresh profile needs no update. Configuration, login state, and sessions
are retained; an incomplete package or failed update stops startup with an error.
This setup targets the bundled Codex version's managed layout and update command;
an alternate version must support those interfaces.

## Validation scope

For the automated local identity, pairing, persistence, and supervisor checks,
run `pnpm test:devbox` from an installed source checkout. This command enforces
both individual test timeouts and an outer process deadline. It uses isolated
temporary state and does not require provider credentials.

This environment exercises the real web → Relay → Controller → native CLI
chain, including session creation, input, tools, history, reconnect behavior and
supported Ask, Side, TPM or Team features. Authenticate each provider whose
features you need to validate, then perform that provider's test scenario.

It is a Linux environment, including on Docker Desktop for macOS or Windows.
It cannot establish Windows/macOS native process behavior, their login services,
or iPhone Safari interaction behavior. An unconfigured provider or a successful
container health check is not evidence that a real model task passed.
