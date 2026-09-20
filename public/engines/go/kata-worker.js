/*
 * Browser worker adapter for saigo-online/katago-webgpu at
 * d5ad1c0423dba989c60a2f06b1848e7eec2b5941.
 * Uses the upstream classic worker message protocol and real kgeSearchBegin ABI.
 * KataGo and the browser port are MIT licensed; see LICENSE-KATAGO.txt.
 */
importScripts("kataeval-mt.js");

const MAX_MOVES = 2048;
const PV_CAPACITY = 32;
const CANDIDATE_CAPACITY = 8;
const POLL_ARGUMENT_TYPES = Array(16).fill("number");
let moduleInstance = null;
let boardSize = 19;
let ready = false;
let moveLocationsPointer = 0;
let moveColorsPointer = 0;
let scalarsPointer = 0;
let valuesPointer = 0;
let pvPointer = 0;
let pvVisitsPointer = 0;
let candidateLocationsPointer = 0;
let candidateVisitsPointer = 0;
let candidateWinRatesPointer = 0;
let candidateScoresPointer = 0;
let candidatePriorsPointer = 0;
let candidateLcbPointer = 0;
let candidateRadiusPointer = 0;
let candidateDeviationPointer = 0;
let ownershipPointer = 0;
let pollToken = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function initialize(request) {
  const moduleBlob = new Blob([request.jsText], { type: "text/javascript" });
  moduleInstance = await createKata({
    wasmBinary: request.wasmBinary,
    mainScriptUrlOrBlob: moduleBlob,
    locateFile: (path) => new URL(path, self.location.href).href,
  });
  boardSize = request.boardSize;
  if (request.forceCpu) moduleInstance.ccall("kgeSetForceCpu", null, ["number"], [1]);
  if (request.fp16) moduleInstance.ccall("kgeSetFp16", null, ["number"], [1]);
  if (request.optimism > 0) {
    moduleInstance.ccall("kgeSetPolicyOptimism", null, ["number"], [request.optimism]);
  }

  const modelResponse = await fetch(request.netFile, { cache: "force-cache", credentials: "same-origin" });
  if (!modelResponse.ok) throw new Error(`fetch ${request.netFile} -> ${modelResponse.status}`);
  moduleInstance.FS.writeFile("/model.bin.gz", new Uint8Array(await modelResponse.arrayBuffer()));
  const loaded = await moduleInstance.ccall(
    "kgeLoad",
    "number",
    ["string", "number"],
    ["/model.bin.gz", boardSize],
    { async: true },
  );
  if (!loaded) throw new Error(`kgeLoad: ${moduleInstance.ccall("kgeError", "string", [], [])}`);

  moveLocationsPointer = moduleInstance._malloc(MAX_MOVES * 4);
  moveColorsPointer = moduleInstance._malloc(MAX_MOVES * 4);
  scalarsPointer = moduleInstance._malloc(7 * 4);
  valuesPointer = moduleInstance._malloc(8 * 4);
  pvPointer = moduleInstance._malloc(PV_CAPACITY * 4);
  pvVisitsPointer = moduleInstance._malloc(PV_CAPACITY * 4);
  candidateLocationsPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateVisitsPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateWinRatesPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateScoresPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidatePriorsPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateLcbPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateRadiusPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  candidateDeviationPointer = moduleInstance._malloc(CANDIDATE_CAPACITY * 4);
  ownershipPointer = moduleInstance._malloc(boardSize * boardSize * 4);
  ready = true;
  return {
    backend: moduleInstance.ccall("kgeBackendIsGpu", "number", [], []) ? "WebGPU" : "CPU (Eigen)",
    version: moduleInstance.ccall("kgeModelVersion", "number", [], []),
  };
}

function writeMoves(moves) {
  const count = Math.min(moves.length, MAX_MOVES);
  const locations = moveLocationsPointer >> 2;
  const colors = moveColorsPointer >> 2;
  for (let index = 0; index < count; index += 1) {
    moduleInstance.HEAP32[locations + index] = moves[index].loc;
    moduleInstance.HEAP32[colors + index] = moves[index].col;
  }
  return count;
}

function pollSearch() {
  const success = moduleInstance.ccall(
    "kgePollAll",
    "number",
    POLL_ARGUMENT_TYPES,
    [
      scalarsPointer,
      valuesPointer,
      pvPointer,
      pvVisitsPointer,
      PV_CAPACITY,
      candidateLocationsPointer,
      candidateVisitsPointer,
      candidateWinRatesPointer,
      candidateScoresPointer,
      candidatePriorsPointer,
      candidateLcbPointer,
      candidateRadiusPointer,
      candidateDeviationPointer,
      CANDIDATE_CAPACITY,
      ownershipPointer,
      boardSize * boardSize,
    ],
  );
  if (!success) throw new Error(`kgePollAll: ${moduleInstance.ccall("kgeError", "string", [], [])}`);
  const scalars = scalarsPointer >> 2;
  return {
    best: moduleInstance.HEAP32[scalars],
    done: Boolean(moduleInstance.HEAP32[scalars + 1]),
  };
}

async function search(request, token) {
  if (!ready) throw new Error("engine not initialized");
  const count = writeMoves(request.moves || []);
  moduleInstance.ccall("kgeStopSearch", "number", [], []);
  const started = await moduleInstance.ccall(
    "kgeSearchBegin",
    "number",
    ["number", "number", "number", "number", "number", "number", "number", "number"],
    [
      moveLocationsPointer,
      moveColorsPointer,
      count,
      request.toPlay,
      request.komi ?? 7.5,
      request.visits | 0,
      request.ms | 0,
      Math.max(1, request.threads | 0),
    ],
    { async: true },
  );
  if (!started) throw new Error(`kgeSearchBegin: ${moduleInstance.ccall("kgeError", "string", [], [])}`);

  let result = pollSearch();
  while (!result.done && token === pollToken) {
    await sleep(75);
    if (token !== pollToken) return null;
    result = pollSearch();
  }
  return token === pollToken ? result : null;
}

async function handleMessage(event) {
  const request = event.data;
  try {
    if (request.type === "init") {
      postMessage({ id: request.id, ok: true, ...(await initialize(request)) });
    } else if (request.type === "strength") {
      if (!ready) throw new Error("engine not initialized");
      moduleInstance.ccall(
        "kgeSetStrength",
        null,
        ["number", "number", "number"],
        [request.visits | 0, request.temp || 0, request.policyTemp || 1],
      );
      postMessage({ id: request.id, ok: true });
    } else if (request.type === 'search') {
      const result = await search(request, pollToken);
      postMessage({ id: request.id, ok: true, superseded: result === null, ...(result || {}) });
    } else {
      throw new Error(`unknown message type: ${request.type}`);
    }
  } catch (error) {
    postMessage({ id: request.id, ok: false, error: String(error && error.message ? error.message : error) });
  }
}

let engineChain = Promise.resolve();
onmessage = (event) => {
  if (event.data.type === "search") pollToken += 1;
  engineChain = engineChain.then(() => handleMessage(event));
};
