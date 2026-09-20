import type { Difficulty } from "../../games/shared";
import {
  getLegalGoMoves,
  playGoMove,
  type GoMove,
  type GoState,
} from "../../games/go";
import { getCachedAsset, putCachedAsset } from "../shared/assetCache";

export type GoAiResult = {
  readonly move: GoMove | "pass";
  readonly engine: "katago" | "local";
  readonly detail: string;
};

type LocalWorkerReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly move: GoMove | "pass";
      readonly nodes: number;
      readonly budget: number;
      readonly depth: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

type KataReply = {
  readonly id?: number;
  readonly ok?: boolean;
  readonly error?: string;
  readonly backend?: string;
  readonly version?: number;
  readonly best?: number;
  readonly superseded?: boolean;
  readonly progress?: boolean;
  readonly diag?: string;
};

type Pending<T> = {
  readonly resolve: (value: T) => void;
  readonly reject: (reason: Error) => void;
  readonly removeAbortListener: () => void;
};

type KataAssets = {
  readonly workerUrl: string;
  readonly moduleText: string;
  readonly wasmBinary: ArrayBuffer;
  readonly modelUrl: string;
};

const KATAGO_COMMIT = "d5ad1c0423dba989c60a2f06b1848e7eec2b5941";
const KATAGO_MODEL_SHA256 = "1a8e05a4ea3fca20dab79410cbb566c760767fcdd2fa0b701cfe259a84cc8b04";
const ENGINE_BASE = "/engines/go/";
const MODEL_FILE = "model-g170e-b10c128.bin.gz";

const KATAGO_BUDGET: Record<
  Difficulty,
  { readonly visits: number; readonly milliseconds: number; readonly moveTemperature: number; readonly policyTemperature: number }
> = {
  easy: { visits: 12, milliseconds: 350, moveTemperature: 0.55, policyTemperature: 1.3 },
  normal: { visits: 80, milliseconds: 1_200, moveTemperature: 0.35, policyTemperature: 1.1 },
  hard: { visits: 400, milliseconds: 3_500, moveTemperature: 0.15, policyTemperature: 1 },
};

function abortError(message = "Go AI search was cancelled"): Error {
  if (typeof DOMException !== "undefined") return new DOMException(message, "AbortError");
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bindAbort(signal: AbortSignal | undefined, abort: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    abort();
    return () => undefined;
  }
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isLegalResult(state: GoState, move: GoMove | "pass"): boolean {
  return playGoMove(state, move).ok;
}

function deterministicEmergencyMove(state: GoState): GoMove | "pass" {
  const moves = getLegalGoMoves(state);
  if (moves.length === 0) return "pass";
  const center = (state.size - 1) / 2;
  let best: GoMove | "pass" = moves[0] ?? "pass";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const move of moves) {
    const distance = Math.abs(move.x - center) + Math.abs(move.y - center);
    if (distance < bestDistance) {
      best = move;
      bestDistance = distance;
    }
  }
  return best;
}

class LocalGoWorkerClient {
  private worker: Worker | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, Pending<LocalWorkerReply>>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./localGo.worker.ts", import.meta.url), {
      type: "module",
      name: "go-local-search",
    });
    worker.onmessage = (event: MessageEvent<LocalWorkerReply>) => {
      const reply = event.data;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      pending.removeAbortListener();
      if (reply.ok) pending.resolve(reply);
      else pending.reject(new Error(reply.error));
    };
    worker.onerror = (event) => {
      const error = new Error(event.message || "Local Go worker failed");
      this.worker = null;
      worker.terminate();
      for (const pending of this.pending.values()) {
        pending.removeAbortListener();
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  search(state: GoState, difficulty: Difficulty, signal: AbortSignal): Promise<LocalWorkerReply & { readonly ok: true }> {
    const worker = this.ensureWorker();
    const id = ++this.requestId;
    return new Promise<LocalWorkerReply & { readonly ok: true }>((resolve, reject) => {
      const onAbort = () => {
        worker.postMessage({ type: "cancel", id });
        this.pending.delete(id);
        reject(abortError());
      };
      const removeAbortListener = bindAbort(signal, onAbort);
      if (signal.aborted) {
        removeAbortListener();
        return;
      }
      this.pending.set(id, {
        resolve: (reply) => {
          if (reply.ok) resolve(reply);
          else reject(new Error(reply.error));
        },
        reject,
        removeAbortListener,
      });
      worker.postMessage({ type: "search", id, state, difficulty });
    });
  }
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

async function fetchRequiredAsset(path: string): Promise<Response> {
  const response = await fetch(path, { cache: "force-cache", credentials: "same-origin" });
  if (!response.ok) throw new Error(`缺少静态资源 ${path}（HTTP ${response.status}）`);
  return response;
}

let kataAssetsPromise: Promise<KataAssets> | null = null;

async function loadKataAssets(): Promise<KataAssets> {
  if (kataAssetsPromise) return kataAssetsPromise;
  kataAssetsPromise = (async () => {
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
      throw new Error("页面未启用 cross-origin isolation / SharedArrayBuffer（需要 COOP: same-origin 与 COEP: require-corp）");
    }

    const workerUrl = `${ENGINE_BASE}kata-worker.js`;
    const moduleUrl = `${ENGINE_BASE}kataeval-mt.js`;
    const wasmUrl = `${ENGINE_BASE}kataeval-mt.wasm`;
    const modelUrl = `${ENGINE_BASE}${MODEL_FILE}`;
    const [workerResponse, moduleResponse, wasmResponse] = await Promise.all([
      fetchRequiredAsset(workerUrl),
      fetchRequiredAsset(moduleUrl),
      fetchRequiredAsset(wasmUrl),
    ]);

    const [workerText, moduleText, wasmBinary] = await Promise.all([
      workerResponse.text(),
      moduleResponse.text(),
      wasmResponse.arrayBuffer(),
    ]);
    if (!workerText.includes("kgeSearchBegin") || !workerText.includes("type === 'search'")) {
      throw new Error(`${workerUrl} 不是固定版本的 KataGo classic worker`);
    }
    if (!moduleText.includes("createKata")) throw new Error(`${moduleUrl} 不是有效的 KataGo Emscripten 模块`);
    const wasmMagic = new Uint8Array(wasmBinary, 0, Math.min(4, wasmBinary.byteLength));
    if (wasmMagic.length !== 4 || wasmMagic[0] !== 0 || wasmMagic[1] !== 97 || wasmMagic[2] !== 115 || wasmMagic[3] !== 109) {
      throw new Error(`${wasmUrl} 不是有效的 WebAssembly 文件`);
    }

    let modelBinary = await getCachedAsset(MODEL_FILE, KATAGO_MODEL_SHA256);
    if (!modelBinary) {
      const modelResponse = await fetchRequiredAsset(modelUrl);
      modelBinary = await modelResponse.arrayBuffer();
      const modelBytes = new Uint8Array(modelBinary);
      if (modelBytes.length < 2 || modelBytes[0] !== 0x1f || modelBytes[1] !== 0x8b) {
        throw new Error(`${modelUrl} 不是有效的 gzip KataGo 模型`);
      }
      const digest = await crypto.subtle.digest("SHA-256", modelBinary);
      const actualSha256 = bytesToHex(new Uint8Array(digest));
      if (actualSha256 !== KATAGO_MODEL_SHA256) {
        throw new Error(`${modelUrl} SHA-256 不匹配（实际 ${actualSha256}）`);
      }
      await putCachedAsset(MODEL_FILE, modelBinary, KATAGO_MODEL_SHA256);
    }

    const modelObjectUrl = URL.createObjectURL(new Blob([modelBinary], { type: "application/gzip" }));
    return { workerUrl, moduleText, wasmBinary, modelUrl: modelObjectUrl };
  })();
  return kataAssetsPromise;
}

function historyToKataMoves(state: GoState): readonly { readonly loc: number; readonly col: 1 | 2 }[] {
  const expectedLength = state.size * state.size;
  const boards = state.history.map((key) => {
    const cells = key.replaceAll("/", "");
    if (cells.length !== expectedLength || /[^.bw]/.test(cells)) {
      throw new Error("GoState.history 不是预期的 b/w/. 棋盘快照格式");
    }
    return cells;
  });
  if (boards.length === 0) throw new Error("GoState.history 缺少初始棋盘快照");

  const moves: { loc: number; col: 1 | 2 }[] = [];
  for (let ply = 1; ply < boards.length; ply += 1) {
    const previous = boards[ply - 1] ?? "";
    const next = boards[ply] ?? "";
    const expectedStone = (ply & 1) === 1 ? "b" : "w";
    let placement = -1;
    for (let index = 0; index < expectedLength; index += 1) {
      if (previous[index] === "." && next[index] === expectedStone) {
        if (placement >= 0) throw new Error(`GoState.history 第 ${ply} 手包含多个落子点`);
        placement = index;
      }
    }
    if (previous !== next && placement < 0) throw new Error(`GoState.history 第 ${ply} 手无法还原`);
    moves.push({ loc: placement, col: expectedStone === "b" ? 1 : 2 });
  }
  return moves;
}

class KataGoClient {
  private worker: Worker | null = null;
  private boardSize: GoState["size"] | null = null;
  private initPromise: Promise<{ readonly backend: string; readonly version: number }> | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, Pending<KataReply>>();

  private stop(error: Error): void {
    this.worker?.terminate();
    this.worker = null;
    this.boardSize = null;
    this.initPromise = null;
    for (const pending of this.pending.values()) {
      pending.removeAbortListener();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private call(data: Record<string, unknown>, signal: AbortSignal, transfer: Transferable[] = []): Promise<KataReply> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("KataGo worker 尚未初始化"));
    const id = ++this.requestId;
    return new Promise<KataReply>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError("KataGo search was cancelled"));
        return;
      }
      const onAbort = () => {
        const error = abortError("KataGo search was cancelled");
        this.stop(error);
        reject(error);
      };
      const removeAbortListener = bindAbort(signal, onAbort);
      this.pending.set(id, { resolve, reject, removeAbortListener });
      worker.postMessage({ ...data, id }, transfer);
    });
  }

  private async initialize(size: GoState["size"], signal: AbortSignal): Promise<{ readonly backend: string; readonly version: number }> {
    if (this.worker && this.boardSize === size && this.initPromise) return this.initPromise;
    if (this.worker) this.stop(new Error("棋盘尺寸已改变，重启 KataGo worker"));

    const assets = await loadKataAssets();
    if (signal.aborted) throw abortError();
    const worker = new Worker(assets.workerUrl, { name: "katago-webgpu" });
    this.worker = worker;
    this.boardSize = size;
    worker.onmessage = (event: MessageEvent<KataReply>) => {
      const reply = event.data;
      if (reply.progress || reply.diag || typeof reply.id !== "number") return;
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      pending.removeAbortListener();
      if (reply.ok) pending.resolve(reply);
      else pending.reject(new Error(reply.error || "KataGo worker 返回未知错误"));
    };
    worker.onerror = (event) => this.stop(new Error(event.message || "KataGo worker 启动失败"));

    const wasmBinary = assets.wasmBinary.slice(0);
    this.initPromise = this.call(
      {
        type: "init",
        netFile: assets.modelUrl,
        boardSize: size,
        wasmBinary,
        jsText: assets.moduleText,
        forceCpu: false,
        fp16: false,
        optimism: 0,
      },
      signal,
      [wasmBinary],
    ).then((reply) => {
      if (!reply.backend || typeof reply.version !== "number") throw new Error("KataGo 初始化响应不完整");
      return { backend: reply.backend, version: reply.version };
    });
    return this.initPromise;
  }

  async search(state: GoState, difficulty: Difficulty, signal: AbortSignal): Promise<GoAiResult> {
    const info = await this.initialize(state.size, signal);
    const moves = historyToKataMoves(state);
    if (moves.length > 2_048) throw new Error("KataGo classic worker 最多可重放 2048 手，当前历史过长");
    const budget = KATAGO_BUDGET[difficulty];
    const strength = await this.call(
      {
        type: "strength",
        visits: budget.visits,
        temp: budget.moveTemperature,
        policyTemp: budget.policyTemperature,
      },
      signal,
    );
    if (!strength.ok) throw new Error(strength.error || "KataGo 强度设置失败");

    const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
    const reply = await this.call(
      {
        type: "search",
        moves,
        toPlay: state.turn === "black" ? 1 : 2,
        komi: 7.5,
        visits: budget.visits,
        ms: budget.milliseconds,
        threads,
        noPonder: true,
      },
      signal,
    );
    if (reply.superseded) throw abortError("KataGo search was superseded");
    if (typeof reply.best !== "number") throw new Error("KataGo 搜索未返回落子");
    const move: GoMove | "pass" =
      reply.best < 0 ? "pass" : { x: reply.best % state.size, y: Math.floor(reply.best / state.size) };
    if (!isLegalResult(state, move)) throw new Error("KataGo 返回了当前规则状态下的非法落子");
    return {
      move,
      engine: "katago",
      detail: `真实 KataGo（${info.backend}，模型 v${info.version}，${budget.visits} visits；上游 ${KATAGO_COMMIT.slice(0, 12)}）`,
    };
  }
}

const localClient = new LocalGoWorkerClient();
const kataGoClient = new KataGoClient();
let activeSearch: AbortController | null = null;

export async function chooseGoMove(
  state: GoState,
  difficulty: Difficulty,
  signal?: AbortSignal,
): Promise<GoAiResult> {
  activeSearch?.abort();
  const controller = new AbortController();
  activeSearch = controller;
  const removeAbortListener = bindAbort(signal, () => controller.abort());

  try {
    if (controller.signal.aborted) throw abortError();
    let kataGoFallbackReason: string;
    try {
      return await kataGoClient.search(state, difficulty, controller.signal);
    } catch (error: unknown) {
      if (isAbortError(error) || controller.signal.aborted) throw abortError();
      kataGoFallbackReason = errorMessage(error);
      if (kataGoFallbackReason.includes("缺少静态资源")) {
        kataGoFallbackReason +=
          "；运行 scripts/engines/prepare-go-engine.sh 生成资源（需要 Emscripten >= 6、Bash >= 4 与 Eigen3）";
      }
    }

    try {
      const reply = await localClient.search(state, difficulty, controller.signal);
      const move = isLegalResult(state, reply.move) ? reply.move : deterministicEmergencyMove(state);
      return {
        move,
        engine: "local",
        detail: `浏览器本地确定性搜索：深度 ${reply.depth}，检查 ${reply.nodes}/${reply.budget} 节点；KataGo 未启用：${kataGoFallbackReason}`,
      };
    } catch (error: unknown) {
      if (isAbortError(error) || controller.signal.aborted) throw abortError();
      return {
        move: deterministicEmergencyMove(state),
        engine: "local",
        detail: `本地 Worker 不可用，采用确定性合法落子；Worker 错误：${errorMessage(error)}；KataGo 未启用：${kataGoFallbackReason}`,
      };
    }
  } finally {
    removeAbortListener();
    if (activeSearch === controller) activeSearch = null;
  }
}
