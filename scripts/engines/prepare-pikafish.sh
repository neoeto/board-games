#!/bin/sh
# Reproducibly builds the optional browser Pikafish engine.
# Requires an activated Emscripten SDK (emcc/em++/emmake), curl, make, tar,
# and either sha256sum or shasum. It never installs host-global tools.
set -eu

TAG='Pikafish-2026-09-06'
COMMIT='4c17cee11f888ae1d48a9494f2e2239f019f0a1f'
SOURCE_SHA256='dde6748080072b0fc9152eb8e559bd9f1db6cb22d8242db7f87c2066f2c2e366'
RELEASE_SHA256='41952bbfe2520faceb5902c69e6ab4845cc999841d2b49a95cc1be7867a25e5b'
MODEL_SHA256='7d13d73569a9b571ba0eb20cf1596247bc2a42738967e61afef6482b231e900e'
MODEL_BYTES='50706378'
SOURCE_URL="https://codeload.github.com/official-pikafish/Pikafish/tar.gz/$COMMIT"
RELEASE_URL="https://github.com/official-pikafish/Pikafish/releases/download/$TAG/Pikafish.2026-09-06.7z"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT="$ROOT/public/engines/xiangqi"
WORK=${PIKAFISH_WORK_DIR:-"$(mktemp -d "${TMPDIR:-/tmp}/just-go-pikafish-wasm.XXXXXX")"}
KEEP_WORK=${PIKAFISH_KEEP_WORK:-0}
JOBS=${PIKAFISH_BUILD_JOBS:-2}

cleanup() {
  if [ "$KEEP_WORK" != '1' ]; then rm -rf "$WORK"; fi
}
trap cleanup EXIT HUP INT TERM

for tool in emcc em++ emmake curl make tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing prerequisite: %s. Activate emsdk and retry; nothing was installed.\n' "$tool" >&2
    exit 2
  fi
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    printf 'Missing prerequisite: sha256sum or shasum.\n' >&2
    exit 2
  fi
}

verify_hash() {
  actual=$(sha256_file "$1")
  if [ "$actual" != "$2" ]; then
    printf 'SHA-256 mismatch for %s\nexpected %s\nactual   %s\n' "$1" "$2" "$actual" >&2
    exit 1
  fi
}

mkdir -p "$WORK/source" "$WORK/release" "$OUTPUT"
curl -fL --retry 2 --connect-timeout 20 --max-time 300 -o "$WORK/source.tar.gz" "$SOURCE_URL"
curl -fL --retry 2 --connect-timeout 20 --max-time 300 -o "$WORK/release.7z" "$RELEASE_URL"
verify_hash "$WORK/source.tar.gz" "$SOURCE_SHA256"
verify_hash "$WORK/release.7z" "$RELEASE_SHA256"

tar -xzf "$WORK/source.tar.gz" -C "$WORK/source"
if ! tar -xf "$WORK/release.7z" -C "$WORK/release"; then
  if command -v 7z >/dev/null 2>&1; then
    7z x -y -o"$WORK/release" "$WORK/release.7z" >/dev/null
  else
    printf 'The local tar cannot extract 7z; install a 7z-capable extractor and retry.\n' >&2
    exit 2
  fi
fi

SOURCE_DIR="$WORK/source/Pikafish-$COMMIT"
MODEL="$WORK/release/pikafish.nnue"
NNUE_LICENSE="$WORK/release/NNUE-License.md"
if [ ! -d "$SOURCE_DIR/src" ] || [ ! -f "$MODEL" ] || [ ! -f "$NNUE_LICENSE" ]; then
  printf 'The hash-verified archives do not contain the expected source/model/license paths.\n' >&2
  exit 1
fi
verify_hash "$MODEL" "$MODEL_SHA256"
actual_model_bytes=$(wc -c < "$MODEL" | tr -d ' ')
if [ "$actual_model_bytes" != "$MODEL_BYTES" ]; then
  printf 'NNUE length mismatch: expected %s, got %s\n' "$MODEL_BYTES" "$actual_model_bytes" >&2
  exit 1
fi

# This is Pikafish's official wasm32 target. Its Makefile supplies -pthread and
# -msimd128; the extra linker flags retain the worker-only runtime, one warm
# search pthread, and only the host hooks consumed by pikafish-host.js.
emmake make -C "$SOURCE_DIR/src" -j "$JOBS" build \
  ARCH=wasm32 COMP=clang COMPCXX=em++ \
  EXTRALDFLAGS='-sENVIRONMENT=worker -sPTHREAD_POOL_SIZE=1 -sEXIT_RUNTIME=0 -sINCOMING_MODULE_JS_API=arguments,locateFile,mainScriptUrlOrBlob,noInitialRun,preRun,print,printErr,stdin -sEXPORTED_RUNTIME_METHODS=FS'

for artifact in pikafish.js pikafish.wasm pikafish.worker.js; do
  if [ ! -f "$SOURCE_DIR/src/$artifact" ]; then
    printf 'Expected Emscripten artifact was not produced: %s\n' "$artifact" >&2
    exit 1
  fi
done

cp "$SOURCE_DIR/src/pikafish.js" "$OUTPUT/pikafish.js"
cp "$SOURCE_DIR/src/pikafish.wasm" "$OUTPUT/pikafish.wasm"
cp "$SOURCE_DIR/src/pikafish.worker.js" "$OUTPUT/pikafish.worker.js"
node "$ROOT/scripts/engines/chunk-model.mjs" \
  --input "$MODEL" \
  --output-dir "$OUTPUT" \
  --sha256 "$MODEL_SHA256"
cp "$SOURCE_DIR/Copying.txt" "$OUTPUT/Pikafish-GPL-3.0.txt"
cp "$NNUE_LICENSE" "$OUTPUT/Pikafish-NNUE-License.md"
cp "$WORK/source.tar.gz" "$OUTPUT/Pikafish-$COMMIT-source.tar.gz"

js_sha=$(sha256_file "$OUTPUT/pikafish.js")
wasm_sha=$(sha256_file "$OUTPUT/pikafish.wasm")
worker_sha=$(sha256_file "$OUTPUT/pikafish.worker.js")
license_sha=$(sha256_file "$OUTPUT/Pikafish-NNUE-License.md")

cat > "$OUTPUT/pikafish.manifest.json" <<EOF
{
  "version": 1,
  "source": {
    "tag": "$TAG",
    "commit": "$COMMIT",
    "archiveSha256": "$SOURCE_SHA256",
    "archiveFile": "Pikafish-$COMMIT-source.tar.gz"
  },
  "model": {
    "manifest": "pikafish.nnue.manifest.json",
    "sha256": "$MODEL_SHA256",
    "bytes": $MODEL_BYTES,
    "licenseFile": "Pikafish-NNUE-License.md",
    "licenseSha256": "$license_sha",
    "chunking": { "strategy": "sha256-manifest", "maxChunkBytes": 16777216 }
  },
  "assets": {
    "script": "pikafish.js",
    "scriptSha256": "$js_sha",
    "wasm": "pikafish.wasm",
    "wasmSha256": "$wasm_sha",
    "pthreadWorker": "pikafish.worker.js",
    "pthreadWorkerSha256": "$worker_sha"
  }
}
EOF

printf 'Prepared hash-verified Pikafish browser assets in %s\n' "$OUTPUT"
printf 'NNUE use is non-commercial without permission; retain Pikafish-NNUE-License.md.\n'
