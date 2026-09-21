# Docker Hosts and Gateway CLI setup

Run a persistent Host for an account-enabled Agent Remote Relay. The image contains the standalone Controller and a pinned Codex CLI. A browser account creates a one-time pairing key with a purpose. Enrollment exchanges it for a private device credential. A `gateway-setup` key additionally authorizes one account-owned Gateway API key and initializes the native providers selected on the Host. A `host-only` key connects existing native CLIs without changing their configuration.

## Prerequisites and rollout order

1. Deploy Gateway migration `0014_agent_remote_host_keys.sql` and its service routes.
2. Deploy the matching account-enabled Relay. Its existing Gateway issuer, Relay origin and service signing secret must agree with Gateway. Both services need HTTPS outside loopback development.
3. Build and start the Controller image below.

This feature does not add account dependencies to the standalone workbench or ordinary Controller. Automatic setup is authorized by the key purpose returned by Relay. Local environment flags, including the legacy `AGENT_HOST_BOOTSTRAP_CODEX`, cannot grant this authority. An older Relay that omits the purpose is treated as `host-only`. The image does not contain a browser login, Google credential, service signing secret, pairing key or Gateway token.

The updated Relay adds pairing-purpose metadata to the strict Host uplink contract. Upgrade Controllers together with this Relay release; older Controllers can reject its registration acknowledgement. New Controllers accept older Relay acknowledgements as `host-only`.

## Manage pairing keys

The website's **Pair Agent Host** panel defaults to **Host only**. Select **Gateway token + CLI setup** only when granting automatic Gateway configuration. The key is shown when created; history never returns the secret. Refresh history to see **Unused**, **Used**, **Obsolete** (expired before use), or **Revoked**.

Each hosted invitation can enroll only once, including simultaneous attempts. A used invitation stays used after its original expiry; the saved device credential supports subsequent connections. Revoke an unused key to prevent enrollment. Deleting an unused record also invalidates the key; deleting a used record removes history only and does not revoke the Host or Gateway token. Use **Revoke Host** to remove that access. History is limited to 512 records; delete old entries before creating more when full.

## One-key startup

Once the matching Gateway and Relay are deployed and the Controller image is available locally, run:

```sh
bash scripts/controller/create-host.sh
```

Missing options are prompted interactively with a short explanation; press Enter to accept each default. The Relay defaults to `https://agents.xianliao.de5.net`, and the Host name suggestion uses weather, city and a random suffix (for example `sunny-kyoto-a1b2c3`). Explicit options skip their prompts. Then paste one pairing key at the private prompt. Choose `gateway-setup` on the website when you need automatic Gateway configuration. No further Google login, account cookie or manually created LLM token is required. The script creates private persistent volumes, starts the Host and waits for selected provider initialization and Relay registration. It transfers the pairing key through stdin into the state volume, without host-file bind mounts or placing the key in Docker arguments/environment.

The default Relay is `https://agents.xianliao.de5.net` and the default local image is `arc-controller-bootstrap-controller:latest`. Build the image below first; this feature branch does not publish an image or deploy the production services. After that, the script itself only needs Bash and Docker, not a source checkout, Node or pnpm. Use `--server` or `--image` for another deployment.

To resume an existing Host, pass its previous `--name` or enter that name at the prompt; omitting the name generates a new suggestion each time. The saved container starts without requesting a key. Use `--name my-second-host` and a new pairing key for an additional Host. Existing unrelated containers/volumes are left intact. A new Host is not reported ready until it has initialized its selected providers and registered with Relay; if initialization fails, its state is retained and the script shows the logs command.

For automation, pass options explicitly and pipe the pairing key into stdin. Non-interactive invocations use defaults for omitted values and reserve stdin exclusively for the key.

A pairing key enrolls one Host. A `gateway-setup` Host receives one stable Gateway key; retries and restarts return the same binding. Revoked keys are not recreated. The device credential and Relay service signature are automatic internal authorization steps, not additional user authentication.

## Choose native providers on the Host

The invitation authorizes setup; it does not choose a CLI. Set `AGENT_HOST_PROVIDERS=codex`, `claude`, or `codex,claude` when starting a local Controller. Docker's helper accepts `--providers`; Compose accepts the same environment variable. The default remains `codex`. For example:

```sh
bash scripts/controller/create-host.sh --providers claude --image your-controller-with-claude:local
```

The bundled image contains Codex only. Selecting Claude requires an image or local installation with Claude Code 2.1.247 or newer. Gateway setup supports Codex and Claude, including both together, using one Host token and the model returned by Gateway. Copilot Gateway setup fails explicitly before requesting a token; use `host-only` with an existing Copilot login instead. A `host-only` Host retains its existing provider configuration for every supported native provider.

Claude uses a private `gateway-claude` home and receives Gateway authentication through its native environment. Its existing native settings in that home are preserved. The Controller currently proxies native `codex` commands; it does not provide a `claude` command proxy. Claude Gateway setup applies to sessions started through the Controller.

## Build the image or use Compose

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build:agent-remote-controller

# Obtain a gateway-setup pairing key from the signed-in agents site's Host pairing action.
# Save it in this private file using your editor; do not paste it into shell arguments.
mkdir -p "$HOME/.config/agent-remote-controller"
chmod 700 "$HOME/.config/agent-remote-controller"
export AGENT_HOST_PAIRING_KEY_FILE="$HOME/.config/agent-remote-controller/docker-pairing-key"
touch "$AGENT_HOST_PAIRING_KEY_FILE"
chmod 600 "$AGENT_HOST_PAIRING_KEY_FILE"
export AGENT_HOST_SERVER=https://your-agents.example
export AGENT_HOST_NAME='Docker Codex'

docker compose -p arc-controller-bootstrap -f compose.controller.yaml build controller
docker compose -p arc-controller-bootstrap -f compose.controller.yaml up -d controller
docker compose -p arc-controller-bootstrap -f compose.controller.yaml logs --tail 30 controller
```

The pairing key file must contain the actual key before `up` and be readable by container UID 1000. On Linux, Compose file secrets retain source-file ownership and permissions; grant UID 1000 read access with a file ACL or use a file owned by UID 1000. Do not make a credential file world-readable. For private npm registries, pass `NPMRC_FILE` as a BuildKit secret. `NPM_REGISTRY` and `CODEX_VERSION` are explicit build overrides. Use a distinct Compose project (`-p project-name`) for every additional Host so its state and workspace volumes are independent.

The account Host list first sees an enrolled Host with no providers, then the ready selected providers after initialization. Failed initialization keeps the accepted device credential; restarting retries provisioning without consuming a new invitation.

## Persistence and native commands

- `controller-state` stores the stable installation ID, device credential, pairing purpose and managed provider homes under `/data/host`.
- `controller-workspace` stores project files under `/workspace`.
- The process runs as UID 1000, uses `LC_ALL=C`, and sets the soft file limit to 8192. Compose sets both limits to 8192.
- When selected for Gateway setup, Codex uses private app-server sessions and a dedicated `gateway-codex` home. Existing personal Codex configuration is never overwritten. Changes to the managed provider fields stop initialization with an actionable error; native project trust settings are preserved across restarts.
- The Gateway token is kept in a mode-0600 private state file and passed to native Codex through `CODEX_GATEWAY_API_KEY`. The TOML config contains only the environment-variable name.

```sh
docker compose -p arc-controller-bootstrap -f compose.controller.yaml exec controller agent-remote-controller codex
docker compose -p arc-controller-bootstrap -f compose.controller.yaml exec controller agent-remote-controller codex resume <session-id>
docker compose -p arc-controller-bootstrap -f compose.controller.yaml restart controller
```

On restart, the entrypoint uses the saved device credential even if Compose still supplies the consumed invitation. It rejects a different Relay with the same volume. A managed Host cannot be hot-paired to another account: use a new state volume. When a running host-only Controller is paired with a Gateway-setup invitation, it saves the device credential and purpose, stops before exposing its existing providers to the new Relay, and reports that a restart is required. Run `agent-remote-controller start` with saved settings to initialize the selected CLIs. Do not run two containers against one state volume.

Keep the pairing file present for Compose secret mounting; its content is ignored after successful enrollment. Replacing the file does not change the identity of an existing Host. To remove a Host, revoke it in the account interface before discarding its state. Removing volumes alone does not revoke server-side credentials.

## Gateway key lifecycle

Gateway binds one API key to `(account subject, Relay, Host ID)`. Retries and restarts reuse the binding. Gateway's normal API-key rotation is picked up on the next Controller startup. Deleting or revoking the key leaves a tombstone, so a restart cannot silently create a replacement.

Host revocation revokes the LLM key before deleting the device. If Gateway is temporarily unavailable, revocation returns an error and can be retried. A Host that never requested a Gateway key retains its previous revocation behavior.

`AGENT_REMOTE_CODEX_MODEL` configures the model returned by Gateway (default `gpt-5.6-sol`). The account must have an enabled upstream supporting that model. Automatic initialization does not create or log into an upstream provider. The same returned model is used for each selected native CLI.

## Local validation

Use the Gateway repository's `bun run agent-remote:fixture` for isolated simulated accounts; it does not perform Google login and does not provide a model upstream. Its readiness file supplies test account bearer sessions. Follow the real `/auth/login` → Gateway `/api/agent-remote/launch` → Relay `/auth/session` flow, then create a pairing key with `{ "purpose": "gateway-setup" }`.

A Docker container's loopback is not the macOS host's loopback. For integration tests, use an explicitly configured loopback forwarder or a reachable HTTPS endpoint; do not weaken the bootstrap HTTPS/origin checks. Testing against a real existing upstream should use an isolated database copy, short-lived simulated login and private test artifacts.

## Environment discovery

Docker and native Controllers advertise their detected OS, shell, installed browsers,
and VS Code to the Host selector. Use keywords such as `linux bash` to choose a session
execution environment. See [Host environment discovery](host-environment.md) for the
local inspection command, detection limits, and Relay-first rollout order.
