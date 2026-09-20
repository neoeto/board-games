#!/usr/bin/env bash
# Cloudflare CLI contract: https://developers.cloudflare.com/workers/wrangler/commands/
# Container prerequisites: https://developers.cloudflare.com/containers/get-started/
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/wrangler.jsonc"
ENVIRONMENT=""
WORKER_NAME=""
MODE="deploy"
CONTAINERS=false
WRANGLER_VERSION="4.134.0"

usage() {
  cat <<'HELP'
Usage: ./scripts/deploy.sh [options]

Deploy an existing Cloudflare Worker project using pinned Wrangler 4.134.0.
Wrangler handles bundling and any build command in the selected configuration.

  --config PATH    Wrangler config (default: repository-root wrangler.jsonc).
                   Explicit relative paths are relative to your current directory.
  --env NAME       Named Wrangler environment; omitted means top-level config.
  --name NAME      Target Worker name; overrides the selected config's name.
                   An existing Worker with this name in the account is updated.
  --containers     Also verify Containers account access and local Docker readiness.
                   Use this for deployments containing the native chess engines.
  --check          Check cloud access and compile the Worker without deploying.
  --dry-run        Compile the Worker only; skip cloud/Docker preflight and upload.
  -h, --help       Show this help.

--check and --dry-run are mutually exclusive. Neither uploads resources.
Dry-run does not prove that a container image builds or can run on Cloudflare.
For container deployments, Wrangler performs the real image build/push on deploy.
This script does not create application code/config, install app dependencies,
log in, start Docker, change billing plans, or upload secrets automatically.
Use Wrangler login or existing Cloudflare environment credentials for auth.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config|--env|--name)
      option="$1"
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || fail "$option requires a value."
      case "$option" in
        --config) CONFIG="$2" ;;
        --env) ENVIRONMENT="$2" ;;
        --name) WORKER_NAME="$2" ;;
      esac
      shift 2
      ;;
    --containers) CONTAINERS=true; shift ;;
    --check|--dry-run)
      [[ "$MODE" == deploy ]] || fail "Choose only one of --check and --dry-run."
      MODE="${1#--}"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Use --help." ;;
  esac
done

[[ -f "$CONFIG" ]] || fail "Wrangler config not found: $CONFIG. This repository currently contains engine experiments; add a real Worker configuration and entrypoint, or pass --config PATH."
# Resolve before changing directory so explicit relative config paths stay correct.
CONFIG="$(cd -- "$(dirname -- "$CONFIG")" && pwd)/$(basename -- "$CONFIG")"
command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npx >/dev/null 2>&1 || fail "npm/npx is required to run Wrangler."
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || fail "Wrangler requires Node.js 20 or newer."

# Use the config's project directory, regardless of where the script was invoked.
cd -- "$(dirname -- "$CONFIG")"
OPTIONS=(--config "$CONFIG")
if [[ -n "$ENVIRONMENT" ]]; then OPTIONS+=(--env "$ENVIRONMENT"); fi
DEPLOY_OPTIONS=("${OPTIONS[@]}")
if [[ -n "$WORKER_NAME" ]]; then DEPLOY_OPTIONS+=(--name "$WORKER_NAME"); fi
wrangler() { npx --yes "wrangler@$WRANGLER_VERSION" "$@"; }

printf 'Config: %s\nEnvironment: %s\nMode: %s\n' "$CONFIG" "${ENVIRONMENT:-top-level}" "$MODE"
printf 'Worker: %s\n' "${WORKER_NAME:-from selected Wrangler configuration}"
if [[ "$MODE" != dry-run ]]; then
  printf 'Checking Cloudflare authentication...\n'
  # --json exits nonzero when unauthenticated; avoid printing account details.
  wrangler whoami "${OPTIONS[@]}" --json >/dev/null || fail "Cloudflare authentication failed. Run npx wrangler@$WRANGLER_VERSION login or configure CI credentials."
  if [[ "$CONTAINERS" == true ]]; then
    printf 'Checking Containers access...\n'
    wrangler containers list "${OPTIONS[@]}" || fail "Containers access failed. Check the selected account, permissions and Workers Paid subscription; no subscription was changed."
    command -v docker >/dev/null 2>&1 || fail "Docker-compatible CLI is required to build container images."
    docker info >/dev/null || fail "Container runtime is unavailable. Start Docker or the configured Podman machine and retry."
  fi
fi

printf 'Compiling and validating Worker (no upload)...\n'
wrangler deploy "${DEPLOY_OPTIONS[@]}" --dry-run
if [[ "$MODE" == dry-run ]]; then
  printf 'Worker dry-run passed. Cloud access and container image build were not verified.\n'
  exit 0
fi
if [[ "$MODE" == check ]]; then
  printf 'Preflight passed. No resources deployed; container image build is not covered by Worker dry-run.\n'
  exit 0
fi

printf 'Deploying to Cloudflare...\n'
wrangler deploy "${DEPLOY_OPTIONS[@]}"
printf 'Wrangler deployment completed. Container readiness, if applicable, must still be checked.\n'
