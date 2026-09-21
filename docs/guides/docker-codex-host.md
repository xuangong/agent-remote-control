# Docker Codex Hosts

Run a persistent Codex Host for an account-enabled Agent Remote Relay. The image contains the standalone Controller and a pinned Codex CLI. A browser account creates a one-time pairing key; enrollment exchanges it for a private device credential, then provisions one account-owned Gateway API key for that Host.

## Prerequisites and rollout order

1. Deploy Gateway migration `0014_agent_remote_host_keys.sql` and its service routes.
2. Deploy the matching account-enabled Relay. Its existing Gateway issuer, Relay origin and service signing secret must agree with Gateway. Both services need HTTPS outside loopback development.
3. Build and start the Controller image below.

This feature does not add account dependencies to the standalone workbench or ordinary Controller. Automatic Codex setup is opt-in with `AGENT_HOST_BOOTSTRAP_CODEX=1`; the Docker image enables it by default. The image does not contain a browser login, Google credential, service signing secret, pairing key or Gateway token.

## One-key startup

Once the matching Gateway and Relay are deployed and the Controller image is available locally, run:

```sh
bash scripts/controller/create-host.sh
```

Missing options are prompted interactively with a short explanation; press Enter to accept each default. The Relay defaults to `https://agents.xianliao.de5.net`, and the Host name suggestion uses weather, city and a random suffix (for example `sunny-kyoto-a1b2c3`). Explicit options skip their prompts. Then paste one pairing key at the private prompt. No further Google login, account cookie or manually created LLM token is required. The script creates private persistent volumes, starts the Host and waits for Codex initialization and Relay registration. It transfers the pairing key through stdin into the state volume, without host-file bind mounts or placing the key in Docker arguments/environment.

The default Relay is `https://agents.xianliao.de5.net` and the default local image is `arc-controller-bootstrap-controller:latest`. Build the image below first; this feature branch does not publish an image or deploy the production services. After that, the script itself only needs Bash and Docker, not a source checkout, Node or pnpm. Use `--server` or `--image` for another deployment.

To resume an existing Host, pass its previous `--name` or enter that name at the prompt; omitting the name generates a new suggestion each time. The saved container starts without requesting a key. Use `--name my-second-host` and a new pairing key for an additional Host. Existing unrelated containers/volumes are left intact. A new Host is not reported ready until it has initialized Codex and registered with Relay; if initialization fails, its state is retained and the script shows the logs command.

For automation, pass options explicitly and pipe the pairing key into stdin. Non-interactive invocations use defaults for omitted values and reserve stdin exclusively for the key.

A pairing key enrolls one Host. That Host receives one stable Gateway key; retries and restarts return the same binding. Revoked keys are not recreated. The device credential and Relay service signature are automatic internal authorization steps, not additional user authentication.

## Build the image or use Compose

From this repository:

```sh
pnpm install --frozen-lockfile
pnpm build:agent-remote-controller

# Obtain a pairing key from the signed-in agents site's Host pairing action.
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

The account Host list first sees an enrolled Host with no providers, then the ready Codex provider after initialization. Failed initialization keeps the accepted device credential; restarting retries provisioning without consuming a new invitation.

## Persistence and native commands

- `controller-state` stores the stable installation ID, device credential and managed Codex home under `/data/host`.
- `controller-workspace` stores project files under `/workspace`.
- The process runs as UID 1000, uses `LC_ALL=C`, and sets the soft file limit to 8192. Compose sets both limits to 8192.
- Codex uses private app-server sessions and a dedicated `gateway-codex` home. Existing personal Codex configuration is never overwritten. Changes to the managed provider fields stop initialization with an actionable error; native project trust settings are preserved across restarts.
- The Gateway token is kept in a mode-0600 private state file and passed to native Codex through `CODEX_GATEWAY_API_KEY`. The TOML config contains only the environment-variable name.

```sh
docker compose -p arc-controller-bootstrap -f compose.controller.yaml exec controller agent-remote-controller codex
docker compose -p arc-controller-bootstrap -f compose.controller.yaml exec controller agent-remote-controller codex resume <session-id>
docker compose -p arc-controller-bootstrap -f compose.controller.yaml restart controller
```

On restart, the entrypoint uses the saved device credential even if Compose still supplies the consumed invitation. It rejects a different Relay with the same volume. A managed Host cannot be hot-paired to another account: use a new state volume. Do not run two containers against one state volume.

Keep the pairing file present for Compose secret mounting; its content is ignored after successful enrollment. Replacing the file does not change the identity of an existing Host. To remove a Host, revoke it in the account interface before discarding its state. Removing volumes alone does not revoke server-side credentials.

## Gateway key lifecycle

Gateway binds one API key to `(account subject, Relay, Host ID)`. Retries and restarts reuse the binding. Gateway's normal API-key rotation is picked up on the next Controller startup. Deleting or revoking the key leaves a tombstone, so a restart cannot silently create a replacement.

Host revocation revokes the LLM key before deleting the device. If Gateway is temporarily unavailable, revocation returns an error and can be retried. A Host that never requested a Gateway key retains its previous revocation behavior.

`AGENT_REMOTE_CODEX_MODEL` configures the model returned by Gateway (default `gpt-5.6-sol`). The account must have an enabled upstream supporting that model. Automatic initialization does not create or log into an upstream provider.

## Local validation

Use the Gateway repository's `bun run agent-remote:fixture` for isolated simulated accounts; it does not perform Google login and does not provide a model upstream. Its readiness file supplies test account bearer sessions. Follow the real `/auth/login` → Gateway `/api/agent-remote/launch` → Relay `/auth/session` flow, then create a pairing key.

A Docker container's loopback is not the macOS host's loopback. For integration tests, use an explicitly configured loopback forwarder or a reachable HTTPS endpoint; do not weaken the bootstrap HTTPS/origin checks. Testing against a real existing upstream should use an isolated database copy, short-lived simulated login and private test artifacts.
