#!/usr/bin/env bash
set +x
set -euo pipefail

server=''
image=''
name=''
network=''
usage() {
  cat <<'HELP'
Usage: bash create-host.sh [--name NAME] [--server URL] [--image IMAGE] [--network NETWORK]

Create a Docker Codex Host using one pairing key, entered privately or read from stdin.
Docker and a built Controller image are required. No account login is performed.
Omitted values are prompted in a terminal; press Enter to accept the displayed default.
  --server   Agents / Relay URL (default: https://agents.xianliao.de5.net)
  --name     Container and Host name (suggested: weather-city-random suffix)
  --image    Installed Controller image (default: arc-controller-bootstrap-controller:latest)
  --network  Docker network (default: bridge; host can be used for local integration)
With piped input, defaults are used and stdin is reserved for the pairing key.
Run again with the same --name to start the saved Host without another key.
Use a different name and a new pairing key for each additional Host.
HELP
}
fail() { printf '%s\n' "$*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --name|--server|--image|--network)
      option=$1; shift
      value=''
      if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then value=$1; shift; fi
      case "$option" in
        --name) name=$value ;; --server) server=$value ;; --image) image=$value ;; --network) network=$value ;;
      esac ;;
    *) fail 'Unknown option. Use --help. Pairing keys are accepted only through stdin.' ;;
  esac
done
prompt_value() {
  local variable=$1 label=$2 fallback=$3 hint=$4 value=''
  [ -z "${!variable}" ] || return 0
  if [ -t 0 ]; then
    printf '\n%s\n%s [%s]: ' "$hint" "$label" "$fallback" >&2
    IFS= read -r value || fail 'Input closed. Pass options explicitly when running without a terminal.'
  fi
  printf -v "$variable" '%s' "${value:-$fallback}"
}
prompt_value server 'Relay URL' 'https://agents.xianliao.de5.net' \
  'Agents / Relay (--server): use the site that issued your pairing key.'
if [ -z "$name" ]; then
  weather=(sunny cloudy rainy snowy windy misty stormy frosty)
  cities=(hangzhou chengdu kyoto oslo lisbon seattle berlin taipei)
  suffix=$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')
  suggested_name="${weather[$((RANDOM % ${#weather[@]}))]}-${cities[$((RANDOM % ${#cities[@]}))]}-$suffix"
  prompt_value name 'Host name' "$suggested_name" \
    'Host name (--name): shown on the agents site; use a previous name to resume that Host.'
fi
prompt_value image 'Controller image' 'arc-controller-bootstrap-controller:latest' \
  'Controller image (--image): the Docker image containing Controller and Codex, already built or pulled.'
prompt_value network 'Docker network' 'bridge' \
  'Docker network (--network): keep bridge for normal use; host is available for local integration.'
[[ "$name" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$ ]] || fail 'Invalid --name. Use letters, digits, dots, underscores or hyphens (up to 80 characters), for example sunny-kyoto-a1b2c3.'
server=${server%/}
if ! [[ "$server" =~ ^https://[^/?#@[:space:]]+$ || "$server" =~ ^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$ ]]; then
  fail 'Invalid --server. Use an HTTPS origin such as https://agents.xianliao.de5.net, or HTTP on loopback for local testing.'
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
    printf '\nPaste the one-time pairing key from %s (input is hidden).\nPairing key: ' "$server" >&2
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
