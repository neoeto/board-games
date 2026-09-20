import type { Difficulty } from "../../games/shared";
import type {
  XiangqiMove,
  XiangqiPiece,
  XiangqiState,
} from "../../games/xiangqi";
import type { XiangqiAiChoice } from "./browserXiangqiAi";

const PIKAFISH_TAG = "Pikafish-2026-09-06";
const PIKAFISH_COMMIT = "4c17cee11f888ae1d48a9494f2e2239f019f0a1f";
const SOURCE_SHA256 = "dde6748080072b0fc9152eb8e559bd9f1db6cb22d8242db7f87c2066f2c2e366";
const MODEL_SHA256 = "7d13d73569a9b571ba0eb20cf1596247bc2a42738967e61afef6482b231e900e";
const MANIFEST_URL = "/engines/xiangqi/pikafish.manifest.json";
const HOST_URL = "/engines/xiangqi/pikafish-host.js";
const INPUT_CAPACITY = 64 * 1024;

interface PikafishManifest {
  readonly version: 1;
  readonly source: {
    readonly tag: string;
    readonly commit: string;
    readonly archiveSha256: string;
  };
  readonly model: {
    readonly manifest: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly licenseFile: string;
  };
  readonly assets: {
    readonly script: string;
    readonly wasm: string;
    readonly pthreadWorker: string;
  };
}

interface HostMessage {
  readonly type: "host-ready" | "stdout" | "error";
  readonly chunk?: string | ArrayBuffer;
  readonly message?: string;
}

interface LineWaiter {
  readonly afterSequence: number;
  readonly predicate: (line: string) => boolean;
  readonly resolve: (line: string) => void;
  readonly reject: (error: unknown) => void;
  readonly timeout: number;
}

interface SearchLimit {
  readonly depth: number;
  readonly nodes: number;
  readonly timeoutMs: number;
}

const SEARCH_LIMITS: Readonly<Record<Difficulty, SearchLimit>> = {
  easy: { depth: 3, nodes: 800, timeoutMs: 2_000 },
  normal: { depth: 7, nodes: 15_000, timeoutMs: 5_000 },
  hard: { depth: 12, nodes: 100_000, timeoutMs: 12_000 },
};

const PIECE_TO_FEN: Readonly<Record<XiangqiPiece["type"], string>> = {
  king: "k",
  advisor: "a",
  elephant: "b",
  horse: "n",
  rook: "r",
  cannon: "c",
  pawn: "p",
};

let availability: Promise<PikafishManifest | null> | null = null;
let session: PikafishSession | null = null;
let queue: Promise<void> = Promise.resolve();

function abortError(): DOMException {
  return new DOMException("象棋思考已取消", "AbortError");
}

function assetUrl(file: string): string {
  return new URL(file, new URL(MANIFEST_URL, window.location.href)).href;
}

function validateManifest(value: unknown): PikafishManifest | null {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Partial<PikafishManifest>;
  if (
    manifest.version !== 1 ||
    manifest.source?.tag !== PIKAFISH_TAG ||
    manifest.source?.commit !== PIKAFISH_COMMIT ||
    manifest.source?.archiveSha256 !== SOURCE_SHA256 ||
    manifest.model?.sha256 !== MODEL_SHA256 ||
    manifest.model?.bytes !== 50_706_378 ||
    !manifest.model?.manifest ||
    !manifest.model?.licenseFile ||
    !manifest.assets?.script ||
    !manifest.assets?.wasm ||
    !manifest.assets?.pthreadWorker
  ) {
    return null;
  }
  return manifest as PikafishManifest;
}

async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}

async function detectPikafish(): Promise<PikafishManifest | null> {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") return null;

  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) return null;
    const manifest = validateManifest(await response.json());
    if (!manifest) return null;

    const requiredAssets = [
      HOST_URL,
      assetUrl(manifest.assets.script),
      assetUrl(manifest.assets.wasm),
      assetUrl(manifest.assets.pthreadWorker),
      assetUrl(manifest.model.manifest),
      assetUrl(manifest.model.licenseFile),
    ];
    const present = await Promise.all(requiredAssets.map(assetExists));
    return present.every(Boolean) ? manifest : null;
  } catch {
    return null;
  }
}

function stateToFen(state: XiangqiState): string {
  const ranks: string[] = [];
  for (const row of state.board) {
    let empty = 0;
    let rank = "";
    for (const piece of row) {
      if (!piece) {
        empty += 1;
        continue;
      }
      if (empty > 0) {
        rank += String(empty);
        empty = 0;
      }
      const symbol = PIECE_TO_FEN[piece.type];
      rank += piece.side === "red" ? symbol.toUpperCase() : symbol;
    }
    if (empty > 0) rank += String(empty);
    ranks.push(rank);
  }

  const side = state.turn === "red" ? "w" : "b";
  const fullMove = Math.max(1, Math.floor(state.moveNumber / 2) + 1);
  return `${ranks.join("/")} ${side} - - 0 ${fullMove}`;
}

function parseUciMove(value: string): XiangqiMove | null {
  const match = /^([a-i])([0-9])([a-i])([0-9])$/.exec(value);
  if (!match) return null;
  return {
    from: { x: match[1].charCodeAt(0) - 97, y: 9 - Number(match[2]) },
    to: { x: match[3].charCodeAt(0) - 97, y: 9 - Number(match[4]) },
  };
}

class PikafishSession {
  readonly #worker: Worker;
  readonly #control: Int32Array;
  readonly #input: Uint8Array;
  readonly #decoder = new TextDecoder();
  readonly #waiters = new Set<LineWaiter>();
  readonly #hostReady: Promise<void>;
  #resolveHostReady: () => void = () => undefined;
  #rejectHostReady: (error: unknown) => void = () => undefined;
  #lineBuffer = "";
  #lineSequence = 0;
  #disposed = false;

  constructor(manifest: PikafishManifest) {
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    const inputBuffer = new SharedArrayBuffer(INPUT_CAPACITY);
    this.#control = new Int32Array(controlBuffer);
    this.#input = new Uint8Array(inputBuffer);

    this.#hostReady = new Promise<void>((resolve, reject) => {
      this.#resolveHostReady = resolve;
      this.#rejectHostReady = reject;
    });
    this.#worker = new Worker(HOST_URL, { name: "pikafish-uci" });
    this.#worker.onmessage = (event: MessageEvent<HostMessage>) => this.#onMessage(event.data);
    this.#worker.onerror = (event) => this.#fail(new Error(event.message || "Pikafish Worker 异常"));
    this.#worker.postMessage({
      type: "init",
      controlBuffer,
      inputBuffer,
      manifest,
      baseUrl: new URL(MANIFEST_URL, window.location.href).href,
    });
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.#withAbort(this.#hostReady, signal);
    const uciBoundary = this.#lineSequence;
    const uciOk = this.#waitForLine((line) => line === "uciok", uciBoundary, 8_000);
    this.#send("uci");
    await this.#withAbort(uciOk, signal);

    this.#send("setoption name Threads value 1");
    this.#send("setoption name Hash value 32");
    this.#send("setoption name Ponder value false");
    this.#send("setoption name EvalFile value /pikafish.nnue");
    await this.#ready(signal);
  }

  async search(
    state: XiangqiState,
    difficulty: Difficulty,
    signal?: AbortSignal,
  ): Promise<XiangqiAiChoice> {
    if (this.#disposed) throw new Error("Pikafish 会话已关闭");
    if (signal?.aborted) throw abortError();

    await this.#ready(signal);
    this.#send(`position fen ${stateToFen(state)}`);

    const limit = SEARCH_LIMITS[difficulty];
    const boundary = this.#lineSequence;
    const bestMoveLine = this.#waitForLine(
      (line) => line.startsWith("bestmove "),
      boundary,
      limit.timeoutMs,
    );
    this.#send(`go depth ${limit.depth} nodes ${limit.nodes}`);

    let line: string;
    try {
      line = await this.#withAbort(bestMoveLine, signal, () => this.#send("stop"));
    } catch (error) {
      this.dispose();
      throw error;
    }

    const token = line.trim().split(/\s+/)[1] ?? "";
    const move = parseUciMove(token);
    if (!move) throw new Error(`Pikafish 返回了无效 bestmove：${token}`);
    return {
      move,
      engine: "pikafish",
      detail: `Pikafish ${PIKAFISH_TAG.replace("Pikafish-", "")} · ${limit.depth} 层上限`,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    try {
      this.#send("stop");
      this.#send("quit");
    } catch {
      // The runtime may already have failed; termination remains authoritative.
    }
    this.#disposed = true;
    Atomics.store(this.#control, 2, 1);
    Atomics.notify(this.#control, 1);
    this.#worker.terminate();
    this.#fail(new Error("Pikafish 会话已关闭"));
  }

  async #ready(signal?: AbortSignal): Promise<void> {
    const boundary = this.#lineSequence;
    const ready = this.#waitForLine((line) => line === "readyok", boundary, 5_000);
    this.#send("isready");
    await this.#withAbort(ready, signal);
  }

  #send(command: string): void {
    if (this.#disposed) throw new Error("Pikafish 会话已关闭");
    const bytes = new TextEncoder().encode(`${command}\n`);
    const read = Atomics.load(this.#control, 0);
    let write = Atomics.load(this.#control, 1);
    const free = (read - write - 1 + this.#input.length) % this.#input.length;
    if (bytes.length > free) throw new Error("Pikafish 输入缓冲区已满");

    for (const byte of bytes) {
      this.#input[write] = byte;
      write = (write + 1) % this.#input.length;
    }
    Atomics.store(this.#control, 1, write);
    Atomics.notify(this.#control, 1);
  }

  #onMessage(message: HostMessage): void {
    if (message.type === "host-ready") {
      this.#resolveHostReady();
      return;
    }
    if (message.type === "error") {
      this.#fail(new Error(message.message || "Pikafish 初始化失败"));
      return;
    }
    if (message.type !== "stdout" || message.chunk === undefined) return;

    this.#lineBuffer +=
      typeof message.chunk === "string"
        ? message.chunk
        : this.#decoder.decode(message.chunk, { stream: true });
    const lines = this.#lineBuffer.split(/\r?\n/);
    this.#lineBuffer = lines.pop() ?? "";
    for (const line of lines) this.#acceptLine(line.trim());
  }

  #acceptLine(line: string): void {
    this.#lineSequence += 1;
    for (const waiter of this.#waiters) {
      if (this.#lineSequence <= waiter.afterSequence || !waiter.predicate(line)) continue;
      clearTimeout(waiter.timeout);
      this.#waiters.delete(waiter);
      waiter.resolve(line);
    }
  }

  #waitForLine(
    predicate: (line: string) => boolean,
    afterSequence: number,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const waiter: LineWaiter = {
        afterSequence,
        predicate,
        resolve,
        reject,
        timeout: window.setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error("等待 Pikafish 响应超时"));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #withAbort<T>(promise: Promise<T>, signal?: AbortSignal, onAbort?: () => void): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());

    return new Promise((resolve, reject) => {
      const abort = () => {
        onAbort?.();
        reject(abortError());
      };
      signal.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", abort);
          reject(error);
        },
      );
    });
  }

  #fail(error: unknown): void {
    this.#rejectHostReady(error);
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

async function getSession(signal?: AbortSignal): Promise<PikafishSession | null> {
  availability ??= detectPikafish();
  const manifest = await availability;
  if (!manifest) return null;
  if (session) return session;

  const candidate = new PikafishSession(manifest);
  try {
    await candidate.initialize(signal);
    session = candidate;
    return candidate;
  } catch (error) {
    candidate.dispose();
    availability = null;
    throw error;
  }
}

export async function chooseWithPikafish(
  state: XiangqiState,
  difficulty: Difficulty,
  signal?: AbortSignal,
): Promise<XiangqiAiChoice | null> {
  const previous = queue;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  queue = previous.catch(() => undefined).then(() => gate);
  await previous.catch(() => undefined);

  try {
    if (signal?.aborted) throw abortError();
    const activeSession = await getSession(signal);
    if (!activeSession) return null;
    return await activeSession.search(state, difficulty, signal);
  } catch (error) {
    if (session) {
      session.dispose();
      session = null;
    }
    throw error;
  } finally {
    release();
  }
}
