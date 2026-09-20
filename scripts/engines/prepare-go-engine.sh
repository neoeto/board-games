#!/usr/bin/env bash
set -euo pipefail

KATAGO_REPOSITORY="https://github.com/saigo-online/katago-webgpu.git"
KATAGO_COMMIT="d5ad1c0423dba989c60a2f06b1848e7eec2b5941"
MODEL_NAME="g170e-b10c128-s1141046784-d204142634.bin.gz"
MODEL_SHA256="1a8e05a4ea3fca20dab79410cbb566c760767fcdd2fa0b701cfe259a84cc8b04"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORK_ROOT="${GO_ENGINE_WORK_DIR:-$PROJECT_ROOT/.cache/go-engine}"
SOURCE_DIR="$WORK_ROOT/katago-webgpu"
OUTPUT_DIR="$PROJECT_ROOT/public/engines/go"

fail() {
  printf 'Go engine preparation failed: %s\n' "$1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required"
command -v python3 >/dev/null 2>&1 || fail "python3 is required to apply the reproducible build-script portability patch"

mkdir -p "$WORK_ROOT" "$OUTPUT_DIR"
if [ ! -d "$SOURCE_DIR/.git" ]; then
  git clone --filter=blob:none --no-checkout "$KATAGO_REPOSITORY" "$SOURCE_DIR"
fi

git -C "$SOURCE_DIR" remote set-url origin "$KATAGO_REPOSITORY"
git -C "$SOURCE_DIR" fetch --depth 1 origin "$KATAGO_COMMIT"
git -C "$SOURCE_DIR" checkout --detach --force "$KATAGO_COMMIT"
git -C "$SOURCE_DIR" clean -fdx

ACTUAL_COMMIT="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
[ "$ACTUAL_COMMIT" = "$KATAGO_COMMIT" ] || fail "source commit mismatch: expected $KATAGO_COMMIT, got $ACTUAL_COMMIT"
git -C "$SOURCE_DIR" diff-index --quiet HEAD -- || fail "pinned source checkout is not clean"

MODEL_SOURCE="$SOURCE_DIR/cpp/tests/models/$MODEL_NAME"
[ -f "$MODEL_SOURCE" ] || fail "pinned source does not contain $MODEL_NAME"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL_MODEL_SHA256="$(sha256sum "$MODEL_SOURCE" | cut -d ' ' -f 1)"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL_MODEL_SHA256="$(shasum -a 256 "$MODEL_SOURCE" | cut -d ' ' -f 1)"
else
  fail "sha256sum or shasum is required"
fi
[ "$ACTUAL_MODEL_SHA256" = "$MODEL_SHA256" ] || fail "model SHA-256 mismatch: expected $MODEL_SHA256, got $ACTUAL_MODEL_SHA256"

if ! command -v emcc >/dev/null 2>&1; then
  EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"
  [ -f "$EMSDK_DIR/emsdk_env.sh" ] || fail "Emscripten >= 6 is required; emcc is not on PATH and $EMSDK_DIR/emsdk_env.sh is missing"
  # shellcheck disable=SC1090
  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null
fi
EMCC_MAJOR="$(emcc --version | sed -n '1s/.*emcc.* \([0-9][0-9]*\)\..*/\1/p')"
[ -n "$EMCC_MAJOR" ] || fail "could not determine the emcc version"
[ "$EMCC_MAJOR" -ge 6 ] || fail "Emscripten >= 6 is required; found major version $EMCC_MAJOR"

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  fail "Bash >= 4 is required by the pinned upstream build-eval.sh; found $BASH_VERSION"
fi

if [ -n "${EIGEN3_INCLUDE_DIR:-}" ]; then
  EIGEN_DIR="$EIGEN3_INCLUDE_DIR"
elif [ -f /opt/homebrew/include/eigen3/Eigen/Core ]; then
  EIGEN_DIR=/opt/homebrew/include/eigen3
elif [ -f /usr/local/include/eigen3/Eigen/Core ]; then
  EIGEN_DIR=/usr/local/include/eigen3
elif [ -f /usr/include/eigen3/Eigen/Core ]; then
  EIGEN_DIR=/usr/include/eigen3
else
  fail "Eigen3 headers are required; set EIGEN3_INCLUDE_DIR to the directory containing Eigen/Core"
fi
[ -f "$EIGEN_DIR/Eigen/Core" ] || fail "EIGEN3_INCLUDE_DIR does not contain Eigen/Core: $EIGEN_DIR"

# The pinned script assumes Linux's /usr/include/eigen3 and always sources ~/emsdk.
# Patch only those two host-path assumptions after commit verification; engine source remains pinned.
BUILD_SCRIPT="$SOURCE_DIR/scripts/build-eval.sh"
python3 - "$BUILD_SCRIPT" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
old_emsdk = 'EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"\nsource "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1'
new_emsdk = 'if ! command -v emcc >/dev/null 2>&1; then\n  EMSDK_DIR="${EMSDK_DIR:-$HOME/emsdk}"\n  source "$EMSDK_DIR/emsdk_env.sh" >/dev/null 2>&1\nfi'
old_eigen = '-isystem /usr/include/eigen3'
new_eigen = '-isystem "$EIGEN3_INCLUDE_DIR"'
if old_emsdk not in text or old_eigen not in text:
    raise SystemExit("pinned build script no longer matches the audited portability patch")
path.write_text(text.replace(old_emsdk, new_emsdk).replace(old_eigen, new_eigen))
PY

EIGEN3_INCLUDE_DIR="$EIGEN_DIR" MT=1 bash "$BUILD_SCRIPT"

for artifact in kataeval-mt.js kataeval-mt.wasm; do
  [ -s "$SOURCE_DIR/web/demo/$artifact" ] || fail "upstream build did not produce $artifact"
  cp "$SOURCE_DIR/web/demo/$artifact" "$OUTPUT_DIR/$artifact"
done
cp "$SOURCE_DIR/web/demo/kata-worker.js" "$OUTPUT_DIR/kata-worker.js"
cp "$MODEL_SOURCE" "$OUTPUT_DIR/model-g170e-b10c128.bin.gz"
cp "$SOURCE_DIR/LICENSE" "$OUTPUT_DIR/LICENSE-KATAGO.txt"

cat > "$OUTPUT_DIR/BUILD-PROVENANCE.txt" <<EOF
KataGo browser source: $KATAGO_REPOSITORY
Pinned commit: $KATAGO_COMMIT
Build command: MT=1 scripts/build-eval.sh
Model source: cpp/tests/models/$MODEL_NAME
Model SHA-256: $MODEL_SHA256
Model dedication: CC0 1.0 Universal
EOF

printf 'Prepared browser KataGo assets in %s\n' "$OUTPUT_DIR"
printf 'Pinned source: %s\n' "$KATAGO_COMMIT"
printf 'Verified model SHA-256: %s\n' "$MODEL_SHA256"
