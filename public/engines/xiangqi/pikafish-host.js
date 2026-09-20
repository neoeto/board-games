/*
 * Browser host for the unmodified Emscripten output produced by Pikafish's
 * official wasm32 Makefile target. Pikafish itself is GPLv3; its NNUE file is
 * non-commercial without permission. The preparation script copies both
 * complete notices beside generated assets.
 */

let started = false;

function fail(error) {
  self.postMessage({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function resolveUrl(file, baseUrl) {
  return new URL(file, baseUrl).href;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadModel(manifest, baseUrl) {
  const manifestUrl = resolveUrl(manifest.model.manifest, baseUrl);
  const response = await fetch(manifestUrl, { cache: "force-cache" });
  if (!response.ok) throw new Error(`无法读取 Pikafish NNUE 分片清单 (${response.status})`);
  const chunkManifest = await response.json();
  if (
    chunkManifest.version !== 1 ||
    chunkManifest.originalFilename !== "pikafish.nnue" ||
    chunkManifest.size !== manifest.model.bytes ||
    chunkManifest.sha256 !== manifest.model.sha256 ||
    !Array.isArray(chunkManifest.chunks) ||
    !Array.isArray(chunkManifest.chunkSizes) ||
    chunkManifest.chunks.length !== chunkManifest.chunkSizes.length
  ) {
    throw new Error("Pikafish NNUE 分片清单校验失败");
  }

  const chunks = await Promise.all(chunkManifest.chunks.map(async (file, index) => {
    const chunkResponse = await fetch(resolveUrl(file, manifestUrl), { cache: "force-cache" });
    if (!chunkResponse.ok) throw new Error(`无法读取 Pikafish NNUE 分片 (${chunkResponse.status})`);
    const chunk = new Uint8Array(await chunkResponse.arrayBuffer());
    if (chunk.byteLength !== chunkManifest.chunkSizes[index]) {
      throw new Error(`Pikafish NNUE 分片 ${index} 长度不匹配`);
    }
    return chunk;
  }));

  const modelBytes = new Uint8Array(manifest.model.bytes);
  let offset = 0;
  for (const chunk of chunks) {
    modelBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== modelBytes.byteLength || await sha256Hex(modelBytes) !== manifest.model.sha256) {
    throw new Error("Pikafish NNUE SHA-256 校验失败");
  }
  return modelBytes;
}

self.onmessage = async (event) => {
  if (started || event.data?.type !== "init") return;
  started = true;

  try {
    const { controlBuffer, inputBuffer, manifest, baseUrl } = event.data;
    if (!(controlBuffer instanceof SharedArrayBuffer) || !(inputBuffer instanceof SharedArrayBuffer)) {
      throw new Error("Pikafish 需要 SharedArrayBuffer 与跨源隔离");
    }

    const control = new Int32Array(controlBuffer);
    const input = new Uint8Array(inputBuffer);
    const modelBytes = await loadModel(manifest, baseUrl);

    const readByte = () => {
      for (;;) {
        const read = Atomics.load(control, 0);
        const write = Atomics.load(control, 1);
        if (read !== write) {
          const byte = input[read];
          Atomics.store(control, 0, (read + 1) % input.length);
          return byte;
        }
        if (Atomics.load(control, 2) !== 0) return null;
        Atomics.wait(control, 1, write);
      }
    };

    const emit = (value) => {
      self.postMessage({ type: "stdout", chunk: `${String(value)}\n` });
    };

    self.Module = {
      arguments: [],
      mainScriptUrlOrBlob: resolveUrl(manifest.assets.script, baseUrl),
      locateFile(path) {
        if (path.endsWith(".wasm")) return resolveUrl(manifest.assets.wasm, baseUrl);
        if (path.endsWith(".worker.js")) {
          return resolveUrl(manifest.assets.pthreadWorker, baseUrl);
        }
        return resolveUrl(path, baseUrl);
      },
      preRun: [() => {
        self.FS.writeFile("/pikafish.nnue", modelBytes);
      }],
      stdin: readByte,
      print: emit,
      printErr: emit,
      noInitialRun: false,
    };

    self.postMessage({ type: "host-ready" });
    importScripts(resolveUrl(manifest.assets.script, baseUrl));
  } catch (error) {
    fail(error);
  }
};
