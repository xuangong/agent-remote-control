#!/usr/bin/env bash
set +x
set -euo pipefail

server=https://agents.xianliao.de5.net
image=arc-controller-bootstrap-controller:latest
name=arc-codex-host
network=bridge
usage() {
  cat <<'HELP'
Usage: bash create-host.sh [--name NAME] [--server URL] [--image IMAGE] [--network NETWORK]

Create a Docker Codex Host using one pairing key, entered privately or read from stdin.
Docker and a built Controller image are required. No account login is performed.
Run again with the same name to start the saved Host without another key.
Use a different name and a new pairing key for each additional Host.
HELP
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --name|--server|--image|--network)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1."
      case "$1" in
        --name) name=$2 ;; --server) server=$2 ;; --image) image=$2 ;; --network) network=$2 ;;
      esac
      shift 2 ;;
    *) fail 'Unknown option. Use --help. Pairing keys are accepted only through stdin.' ;;
  esac
done
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$ ]] || fail 'Use a Docker Host name with letters, digits, dots, underscores or hyphens (up to 80 characters).'
server=${server%/}
if ! [[ "$server" =~ ^https://[^/?#@[:space:]]+$ || "$server" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]]; then
  fail 'The Relay must be an HTTPS origin, or HTTP on loopback for local testing.'
fi
command -v docker >/dev/null || fail 'Docker is required. Install and start Docker before running this script.'
docker info --format '{{.ServerVersion}}' >/dev/null || fail 'Docker is not available. Start Docker and retry.'
label=com.agent-remote-control
existing=$(docker inspect --format '{{index .Config.Labels "com.agent-remote-control.managed"}} {{index .Config.Labels "com.agent-remote-control.relay"}}' "$name" 2>/dev/null || true)
if [ -n "$existing" ]; then
  [ "$existing" = "docker-host $server" ] || fail "Container $name belongs to another setup. Use a different --name; nothing was changed."
  docker start "$name" >/dev/null
  printf 'Saved Host %s is running. Open %s to use it.\n' "$name" "$server"
  exit 0
else
  docker image inspect "$image" >/dev/null 2>&1 || fail "Controller image $image is not installed. Build it using the Docker Host guide, or pull a published image and pass --image."
  key=''
  if [ -t 0 ]; then
    printf 'Pairing key: ' >&2
    IFS= read -r -s key || true
    printf '\n' >&2
  else
    IFS= read -r key || true
  fi
  [[ "$key" =~ ^arc_[A-Za-z0-9_-]{43}$ ]] || fail 'A valid one-time pairing key is required.'
  for volume in "$name-state" "$name-workspace"; do
    if owner=$(docker volume inspect --format '{{index .Labels "com.agent-remote-control.managed"}}' "$volume" 2>/dev/null); then
      [ "$owner" = 'docker-host' ] || fail "Volume $volume belongs to another setup. Use a different --name."
    else
      docker volume create --label "$label.managed=docker-host" "$volume" >/dev/null
    fi
  done
  # Send the invitation over stdin into the private state volume, never Docker's environment or arguments.
  if ! printf '%s\n' "$key" | docker run --rm -i --network none --user 1000:1000 \
      --mount "type=volume,src=$name-state,dst=/data" --entrypoint sh "$image" -c \
      'set -eu; umask 077; mkdir -p /data/host; if [ -f /data/host/connection.json ]; then cat >/dev/null; else cat > /data/host/pairing-key; fi'; then
    unset key
    fail 'Could not save the pairing key privately. No Host container was started.'
  fi
  unset key
  docker create --name "$name" --init --restart unless-stopped --stop-timeout 30 \
    --network "$network" --ulimit nofile=8192:8192 \
    --label "$label.managed=docker-host" --label "$label.relay=$server" \
    --env "AGENT_HOST_SERVER=$server" --env "AGENT_HOST_NAME=$name" \
    --env AGENT_HOST_REMOTE_KEY_FILE=/data/host/pairing-key \
    --mount "type=volume,src=$name-state,dst=/data" \
    --mount "type=volume,src=$name-workspace,dst=/workspace" "$image" >/dev/null
  docker start "$name" >/dev/null
fi
printf 'Waiting for %s to finish pairing and Codex initialization...\n' "$name"
deadline=$((SECONDS + 60))
while [ "$SECONDS" -lt "$deadline" ]; do
  state=$(docker inspect --format '{{.State.Running}} {{.State.StartedAt}}' "$name" 2>/dev/null || true)
  status=''
  if [[ "$state" == true\ * ]]; then
    status=$(docker logs --since "${state#true }" --tail 100 "$name" 2>&1 | grep -E '"event":"uplink_(registered|connecting|disconnected|rejected|closed)"' | tail -1 || true)
  fi
  if [[ "$status" == *'"event":"uplink_registered"'* ]]; then
    printf 'Host %s is ready. Open %s to create a Codex session.\n' "$name" "$server"
    printf 'Restart: docker restart %s\n' "$name"
    exit 0
  fi
  sleep 1
done
fail "Host $name did not become ready within 60 seconds. State was preserved. Check: docker logs --tail 40 $name"
