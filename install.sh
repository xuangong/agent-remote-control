#!/bin/sh
# Install a published Controller without a source checkout.
set +x
set -eu

main() {
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: sh install.sh [options]
  --clean                 Reinstall the Controller runtime (requires --yes without a terminal)
  --yes                   Explicitly approve updating an existing installation
  --foreground            Run in the foreground (automatic inside containers)
  --version X.Y.Z         Select a published release (default: latest stable)
  --server URL            Relay origin (default: https://agents.xianliao.de5.net)
  --name NAME             Host name (default: weather-city-random suggestion)
  --providers LIST        Native providers (default: codex)
  --key-file PATH         Read a one-time pairing key from a private file
  --key-stdin             Read the key from stdin (download this script first)
  --prefix PATH           Native install directory (default: ~/.local/share/agent-remote-controller)
  --bin-dir PATH          Native command directory (default: ~/.local/bin)
  --state-dir PATH        Existing or new Host state directory
  --no-start              Install the native command without pairing or starting
  --install-codex         Install pinned Codex privately if it is not on PATH
  --help                  Show this help

Requires Node >=22, npm, curl and tar on macOS, Linux, or inside your container.
No Docker CLI, sudo or npm global install is used.
Keys are prompted privately from the terminal unless a key input option is set.
Existing installations are checked for compatible updates and require confirmation.
Updates preserve Host state and use the existing safe restart and rollback flow. --no-start is suitable for container image builds;
run agent-remote-controller foreground at container runtime, with persistent state.
HELP
}
foreground=0;
if [ -f /.dockerenv ] || [ -f /run/.containerenv ] || [ -n "${container:-}" ]; then foreground=1; fi
 version=''; server=''; name=''; providers=codex
prefix=${AGENT_CONTROLLER_INSTALL_DIR:-"$HOME/.local/share/agent-remote-controller"}
bin_dir=${AGENT_CONTROLLER_BIN_DIR:-"$HOME/.local/bin"}
state_dir=${AGENT_HOST_STATE_DIR:-"$HOME/.agent-remote-control/agent-host"}
yes=0; clean=0; bin_explicit=0; state_explicit=0;
[ -z "${AGENT_HOST_STATE_DIR:-}" ] || state_explicit=1
key_file=''; key_stdin=0; no_start=0; install_codex=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --foreground) foreground=1; shift ;;
    --yes) yes=1; shift ;;
    --clean) clean=1; shift ;;
    --no-start) no_start=1; shift ;;
    --install-codex) install_codex=1; shift ;;
    --key-stdin) key_stdin=1; shift ;;
    --version|--server|--name|--providers|--key-file|--prefix|--bin-dir|--state-dir)
      option=$1; [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $option."
      case "$2" in --*) fail "Missing value for $option." ;; esac
      value=$2; shift 2
      case "$option" in
        --version) version=$value ;; --server) server=$value ;; --name) name=$value ;; --providers) providers=$value ;;
        --key-file) key_file=$value ;; --prefix) prefix=$value ;; --bin-dir) bin_dir=$value; bin_explicit=1 ;; --state-dir) state_dir=$value; state_explicit=1 ;;
      esac ;;
    *) fail 'Unknown option. Use --help; never put a pairing key in command arguments.' ;;
  esac
done

[ -z "$key_file" ] || [ "$key_stdin" = 0 ] || fail 'Choose --key-file or --key-stdin.'

case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) fail 'This installer supports macOS and Linux.' ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) fail 'Only ARM64 and x64 are supported.' ;; esac
for command in curl tar; do command -v "$command" >/dev/null || fail "$command is required."; done
command -v node >/dev/null && command -v npm >/dev/null || fail 'Install Node.js 22 or newer with npm, then run this script again.'
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || fail 'Node.js 22 or newer is required.'
node_path=$(node -p 'process.execPath')
json_node() { "$node_path" "$@"; }
json_node -e '
const [v,p,...paths]=process.argv.slice(1);
if(v && !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(v))throw Error("Invalid release version");
if(!/^(codex|claude|copilot)(,(codex|claude|copilot))*$/.test(p))throw Error("Unsupported providers");
if([v,p,...paths].some(s=>s.includes("\n"))||paths.some(p=>!p.startsWith("/")))throw Error("Use absolute paths without newlines");
' "$version" "$providers" "$prefix" "$bin_dir" "$state_dir"
command_path="$bin_dir/agent-remote-controller"
umask 077
stage=$(mktemp -d "${TMPDIR:-/tmp}/arc-install.XXXXXXXX")
tty_settings=''; install_stage=''
cleanup() {
  if [ -n "$tty_settings" ]; then stty "$tty_settings" </dev/tty 2>/dev/null || true; fi
  rm -rf "$stage"
  if [ -n "$install_stage" ]; then rm -rf "$install_stage"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
fetch() { curl --fail --location --silent --show-error --connect-timeout 15 --max-time 120 --retry 2 --proto '=https' --proto-redir '=https' "$1" -o "$2"; }
prompt() {
  prompt_label=$1; prompt_fallback=$2; reply=''
  if [ "$key_stdin" = 0 ] && [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
    printf '%s [%s]: ' "$prompt_label" "$prompt_fallback" >/dev/tty
    IFS= read -r reply </dev/tty || true
  fi
  printf '%s' "${reply:-$prompt_fallback}"
}
# Delegate to the running Controller so runtime compatibility and safe restart
# decisions use the actual Host, including its Node runtime inside Docker.
update_existing() {
  set -- update --check
  [ -z "$version" ] || set -- "$@" --version "$version"
  controller "$@" > "$stage/update.json" || fail 'Cannot check this installation. Start its Controller first. Older Controllers without the update command must be updated once through the website. Existing files were not changed.'
  json_node -e '
const c=JSON.parse(require("fs").readFileSync(0,"utf8"));
if(typeof c.available!=="boolean"||typeof c.current!=="string"|| ((c.available||c.canClean)&&!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(c.version)))throw Error("Invalid update check");
console.log(c.available||c.canClean?c.version:"");
console.log(c.available?`Update available: ${c.current} -> ${c.version}`:(c.message||"No compatible newer release."));
console.log(c.available?"yes":"no"); console.log(c.canClean?"yes":"no");
' < "$stage/update.json" > "$stage/update-check"
  target=$(sed -n '1p' "$stage/update-check"); message=$(sed -n '2p' "$stage/update-check")
  available=$(sed -n '3p' "$stage/update-check"); can_clean=$(sed -n '4p' "$stage/update-check")
  printf '%s\n' "$message"
  [ "$clean" = 0 ] || [ "$can_clean" = yes ] || fail 'Clean install is unavailable for this launcher or release; existing files were not changed.'
  [ -n "$target" ] || return 0
  printf 'The Controller will briefly reconnect; identity and configuration are preserved. Unsafe restarts wait for a safe window.\n'
  [ "$available" = no ] || printf '  Update: install the newer release with rollback.\n'
  [ "$can_clean" = no ] || printf '  Clean install: uninstall and reinstall the runtime; keep the bootstrap launcher, Host identity, settings and history.\n'
  answer=cancel
  if [ "$yes" = 1 ]; then
    if [ "$clean" = 1 ]; then answer=clean; elif [ "$available" = yes ]; then answer=update; fi
  elif [ "$clean" = 1 ]; then
    case "$(prompt 'Confirm clean install? yes/no' 'no')" in y|Y|yes|YES) answer=clean ;; esac
  else answer=$(prompt 'Choose Update / Clean install / Cancel' 'cancel'); fi
  case "$answer" in
    u|U|update|Update|y|Y|yes|YES)
      [ "$available" = yes ] || fail 'There is no newer compatible release. Choose Clean install to reinstall.'
      controller update --version "$target" --yes ;;
    c|C|clean|'clean install'|'Clean install')
      [ "$can_clean" = yes ] || fail 'This launcher does not support clean install.'
      controller update --version "$target" --yes --clean ;;
    *) printf 'Installation not changed. Rerun interactively to approve an update, or use --yes.\n' ;;
  esac
}
existing=''
if [ -e "$command_path" ] || [ -L "$command_path" ]; then existing=$command_path
elif [ "$bin_explicit" = 0 ]; then existing=$(command -v agent-remote-controller || true); fi
if [ -n "$existing" ]; then
  controller() { if [ "$state_explicit" = 1 ]; then AGENT_HOST_STATE_DIR="$state_dir" "$existing" "$@"; else "$existing" "$@"; fi; }
  update_existing; return
fi
[ ! -e "$state_dir/connection.json" ] && [ ! -e "$state_dir/daemon.json" ] || fail 'This state directory already belongs to a Host. Locate its existing command and use --bin-dir; do not create another identity.'
repo=https://github.com/xuangong/agent-remote-control/releases
if [ -z "$version" ]; then
  location=$(curl --fail --location --silent --show-error --connect-timeout 15 --max-time 30 --proto '=https' --proto-redir '=https' -o /dev/null -w '%{url_effective}' "$repo/latest")
  case "$location" in "$repo/tag/controller-v"*) ;; *) fail 'The latest GitHub release is not a stable Controller release.' ;; esac
  version=${location##*/controller-v}
  json_node -e 'if(!/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(process.argv[1])||process.argv[1].includes("\n"))throw Error("Invalid release tag");' "$version"
fi
printf 'Installing Controller %s for %s-%s...\n' "$version" "$platform" "$arch"
fetch "$repo/download/controller-v$version/controller-release.json" "$stage/release.json"
json_node -e '
const fs=require("fs"),m=JSON.parse(fs.readFileSync(0,"utf8"));const [version,platform]=process.argv.slice(1);
if(m.version!==version || !/^[a-f0-9]{40}$/.test(m.revision) || !/^[a-f0-9]{64}$/.test(m.sha256)
 || m.asset!==`orchardworks-agent-remote-controller-${version}.tgz` || !Array.isArray(m.platforms) || !m.platforms.includes(platform)
 || !Number.isInteger(m.nodeMajor) || m.nodeMajor<22 || Number(process.versions.node.split(".")[0])<m.nodeMajor)
 throw Error("Release does not support this platform or Node version, or its manifest is invalid.");
console.log(m.sha256); console.log(m.revision);
' "$version" "$platform-$arch" < "$stage/release.json" > "$stage/verified"
checksum=$(sed -n '1p' "$stage/verified"); revision=$(sed -n '2p' "$stage/verified")
archive="orchardworks-agent-remote-controller-$version.tgz"
fetch "$repo/download/controller-v$version/$archive" "$stage/$archive"
if command -v sha256sum >/dev/null; then actual=$(sha256sum "$stage/$archive"); else actual=$(shasum -a 256 "$stage/$archive"); fi
[ "${actual%% *}" = "$checksum" ] || fail 'Controller package checksum mismatch. Nothing was installed.'
# Only package-owned paths are read from the verified archive.
tar -xOf "$stage/$archive" package/build-info.json > "$stage/build-info.json"
json_node -e 'const fs=require("fs"),v=JSON.parse(fs.readFileSync(0,"utf8"));if(v.version!==process.argv[1]||v.revision!==process.argv[2]||v.dirty!==false)throw Error("Package identity does not match release");' "$version" "$revision" < "$stage/build-info.json"

if [ "$no_start" = 0 ]; then
  [ -n "$server" ] || server=$(prompt 'Agents / Relay URL' 'https://agents.xianliao.de5.net')
  server=${server%/}
  json_node -e 'const s=process.argv[1];if(!(/^https:\/\/[^/?#@\s]+$/.test(s)||/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$/.test(s)))throw Error("Use an HTTPS Relay origin (HTTP only on loopback)");' "$server"
  if [ -z "$name" ]; then
    suggested=$(json_node -e 'const c=require("crypto"),w=["sunny","cloudy","rainy","snowy","windy","misty","stormy","frosty"],t=["hangzhou","chengdu","kyoto","oslo","lisbon","seattle","berlin","taipei"];console.log(w[c.randomInt(w.length)]+"-"+t[c.randomInt(t.length)]+"-"+c.randomBytes(3).toString("hex"))')
    name=$(prompt 'Host name' "$suggested")
  fi
  json_node -e 'if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(process.argv[1])||process.argv[1].includes("\n"))throw Error("Use a Host name of up to 80 letters, digits, dots, underscores or hyphens");' "$name"
  printf '\nOpen %s and sign in, then open Settings > Pair Agent Host (Pairing keys).\n' "$server"
  printf 'Choose Host only, or Gateway token + CLI setup to initialize your selected providers.\n'
  printf 'Click Generate pairing key. Each key enrolls one Host and expires after use.\n'
  printf 'Copy only the arc_... key from the configuration, return here and paste it; input is hidden.\n\n'
  key=''
  if [ -n "$key_file" ]; then IFS= read -r key < "$key_file" || true
  elif [ "$key_stdin" = 1 ]; then IFS= read -r key || true
  elif [ -r /dev/tty ] && ( : </dev/tty ) 2>/dev/null; then
    tty_settings=$(stty -g </dev/tty)
    stty -echo </dev/tty
    printf 'One-time pairing key from %s (hidden): ' "$server" >/dev/tty
    IFS= read -r key </dev/tty || true
    stty "$tty_settings" </dev/tty; tty_settings=''
    printf '\n' >/dev/tty
  else fail 'No terminal available. Use --key-file or --key-stdin, or --no-start to install only.'; fi
  printf '%s' "$key" | json_node -e 'const k=require("fs").readFileSync(0,"utf8");if(!/^arc_[A-Za-z0-9_-]{43}$/.test(k)||k.length!==47)process.exit(1)' || fail 'A valid one-time pairing key is required.'
fi
mkdir -p "$prefix" "$bin_dir"
package_dir="$prefix/packages/$version-$revision"
[ ! -e "$package_dir" ] || fail 'This package is already installed. Use the existing command or website updates.'
# Stage on the destination filesystem so activation is a rename, not a partial copy.
install_stage=$(mktemp -d "$prefix/.install.XXXXXXXX")
npm install --prefix "$install_stage" --ignore-scripts --no-audit --no-fund --no-package-lock "$stage/$archive"
package_root="$install_stage/node_modules/@orchardworks/agent-remote-controller"
"$node_path" "$package_root/dist/launcher.js" --version
if [ "$install_codex" = 1 ] && ! command -v codex >/dev/null; then
  npm install --prefix "$prefix/native" --ignore-scripts --no-audit --no-fund --no-package-lock '@openai/codex@0.155.1'
fi
if [ "$no_start" = 0 ]; then
  for provider in $(printf '%s' "$providers" | tr \, ' '); do
    if [ "$provider" = codex ] && [ -x "$prefix/native/node_modules/.bin/codex" ]; then continue; fi
    command -v "$provider" >/dev/null || fail "Install $provider first (use --install-codex for Codex), or use --no-start to install Controller only."
  done
fi
mkdir -p "$prefix/packages"
mv "$install_stage" "$package_dir"
# Generate shell literals without evaluating path contents or saving credentials.
"$node_path" - "$node_path" "$package_dir" "$state_dir" "$prefix/native/node_modules/.bin" "$command_path" <<'JS'
const fs = require('fs'), path = require('path');
const [node, pkg, state, nativeBin, command] = process.argv.slice(2);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const wrapper = '#!/bin/sh\n# Managed by Agent Remote Controller install.sh.\n'
 + 'if [ -z "${AGENT_HOST_STATE_DIR:-}" ]; then AGENT_HOST_STATE_DIR=' + quote(state) + '; fi\nexport AGENT_HOST_STATE_DIR\n'
 + 'export LC_ALL=C\nexport AGENT_HOST_CODEX_NOFILE="${AGENT_HOST_CODEX_NOFILE:-8192}"\n'
 + 'export PATH=' + quote(nativeBin + ':' + path.dirname(node)) + ':"$PATH"\n'
 + 'exec ' + quote(node) + ' ' + quote(path.join(pkg, 'node_modules/@orchardworks/agent-remote-controller/dist/launcher.js')) + ' "$@"\n';
fs.writeFileSync(command + '.installing', wrapper, { mode: 0o755, flag: 'wx' });
fs.renameSync(command + '.installing', command);
JS
printf 'Installed: %s\n' "$command_path"
case ":$PATH:" in *":$bin_dir:"*) ;; *) printf 'Add this directory to your shell PATH: %s\n' "$bin_dir" ;; esac
if [ "$no_start" = 1 ]; then
  printf 'Installation complete. Pair and start at runtime; use foreground inside a container.\n'
  exit 0
fi
export AGENT_HOST_STATE_DIR="$state_dir" AGENT_HOST_SERVER="$server" AGENT_HOST_NAME="$name" AGENT_HOST_PROVIDERS="$providers"
export AGENT_HOST_REMOTE_KEY="$key"
unset key
if [ "$foreground" = 1 ]; then
  printf 'Container / foreground mode: keep this process running to keep the Host online.\n'
  cleanup
  trap - 0 INT TERM HUP
  exec "$command_path" foreground
fi
"$command_path" start
unset AGENT_HOST_REMOTE_KEY AGENT_HOST_SERVER
printf 'Waiting for Host registration...\n'
attempt=0
while [ "$attempt" -lt 30 ]; do
  if "$command_path" status > "$stage/status" 2>&1 && grep -q 'uplink: registered' "$stage/status"; then
    printf 'Host %s is ready. Open %s to use it.\n' "$name" "$server"; exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
fail "Controller was installed but registration is not confirmed. State was preserved; inspect: $command_path status"

}
main "$@"
