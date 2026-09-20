#!/usr/bin/env bash
# Cloudflare CLI contract: https://developers.cloudflare.com/workers/wrangler/commands/
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/wrangler.jsonc"
ENVIRONMENT=""
WORKER_NAME=""
MODE="deploy"
WRANGLER_VERSION="4.135.0"

usage() {
  cat <<'HELP'
Usage: ./scripts/deploy.sh [options]

Deploy an existing Cloudflare Worker project using pinned Wrangler 4.135.0.
Wrangler handles bundling and any build command in the selected configuration.

  --config PATH    Wrangler config (default: repository-root wrangler.jsonc).
                   Explicit relative paths are relative to your current directory.
  --env NAME       Named Wrangler environment; omitted means top-level config.
  --name NAME      Target Worker name; overrides the selected config's name.
                   Existing Workers are updated; missing Workers are created.
  --check          Check cloud access and compile the Worker without deploying.
  --dry-run        Compile the Worker only; skip cloud preflight and upload.
  -h, --help       Show this help.

--check and --dry-run are mutually exclusive. Neither uploads resources.
This script does not create application code/config, install app dependencies,
log in, change billing plans, or upload secrets automatically.
Use Wrangler login or existing Cloudflare environment credentials for auth.
HELP
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
detect_worker_action() {
  local output
  if output="$(wrangler versions list "${DEPLOY_OPTIONS[@]}" --json 2>&1)"; then
    DEPLOY_ACTION="update"
    return
  fi
  # Cloudflare API code 10007 is the documented CLI response for a missing Worker.
  # Any other failure may be auth, permissions, account selection, or networking.
  if [[ "$output" == *"[code: 10007]"* ]]; then
    DEPLOY_ACTION="create"
    return
  fi
  printf '%s\n' "$output" >&2
  fail "Could not determine whether the target Worker exists; refusing to treat an API failure as a missing Worker."
}

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
    --check|--dry-run)
      [[ "$MODE" == deploy ]] || fail "Choose only one of --check and --dry-run."
      MODE="${1#--}"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1. Use --help." ;;
  esac
done

[[ -f "$CONFIG" ]] || fail "Wrangler config not found: $CONFIG. Pass --config PATH to select another configuration."
# Resolve before changing directory so explicit relative config paths stay correct.
CONFIG="$(cd -- "$(dirname -- "$CONFIG")" && pwd)/$(basename -- "$CONFIG")"
command -v node >/dev/null 2>&1 || fail "Node.js is required."
command -v npx >/dev/null 2>&1 || fail "npm/npx is required to run Wrangler."
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || fail "Wrangler requires Node.js 22 or newer."

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
  printf 'Checking target Worker...\n'
  detect_worker_action
  if [[ "$DEPLOY_ACTION" == create ]]; then
    printf 'Plan: create missing Worker %s.\n' "${WORKER_NAME:-from selected Wrangler configuration}"
  else
    printf 'Plan: update existing Worker %s.\n' "${WORKER_NAME:-from selected Wrangler configuration}"
  fi

fi
printf 'Generating bindings and checking TypeScript...\n'
npm run typecheck

printf 'Compiling and validating Worker (no upload)...\n'
wrangler deploy "${DEPLOY_OPTIONS[@]}" --dry-run
if [[ "$MODE" == dry-run ]]; then
  printf 'Worker dry-run passed. Cloud access was not verified.\n'
  exit 0
fi
if [[ "$MODE" == check ]]; then
  printf 'Preflight passed. No resources deployed.\n'
  exit 0
fi

printf 'Deploying Worker on Cloudflare (%s)...\n' "$DEPLOY_ACTION"
wrangler deploy "${DEPLOY_OPTIONS[@]}"
printf 'Wrangler deployment completed.\n'
