import type { Difficulty } from "../../games/shared";
import {
  getLegalXiangqiMoves,
  type XiangqiMove,
  type XiangqiState,
} from "../../games/xiangqi";
import { chooseWithPikafish } from "./pikafishClient";

export interface XiangqiAiChoice {
  readonly move: XiangqiMove;
  readonly engine: "pikafish" | "local";
  readonly detail: string;
}

interface LocalRequest {
  readonly id: number;
  readonly state: XiangqiState;
  readonly difficulty: Difficulty;
}

interface LocalSuccess {
  readonly id: number;
  readonly ok: true;
  readonly move: XiangqiMove;
  readonly depth: number;
  readonly nodes: number;
}

interface LocalFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: string;
}

type LocalResponse = LocalSuccess | LocalFailure;

let nextRequestId = 1;

function abortError(): DOMException {
  return new DOMException("象棋思考已取消", "AbortError");
}

function sameMove(left: XiangqiMove, right: XiangqiMove): boolean {
  return (
    left.from.x === right.from.x &&
    left.from.y === right.from.y &&
    left.to.x === right.to.x &&
    left.to.y === right.to.y
  );
}

function chooseLocally(
  state: XiangqiState,
  difficulty: Difficulty,
  signal?: AbortSignal,
): Promise<XiangqiAiChoice> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  const worker = new Worker(new URL("./localSearch.worker.ts", import.meta.url), {
    type: "module",
    name: "xiangqi-local-search",
  });
  const id = nextRequestId++;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const onAbort = () => fail(abortError());

    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onerror = (event) => {
      fail(new Error(event.message || "本地象棋引擎启动失败"));
    };
    worker.onmessage = (event: MessageEvent<LocalResponse>) => {
      const response = event.data;
      if (settled || response.id !== id) return;
      if (!response.ok) {
        fail(new Error(response.error));
        return;
      }

      const legalMoves = getLegalXiangqiMoves(state);
      if (!legalMoves.some((move) => sameMove(move, response.move))) {
        fail(new Error("本地象棋引擎返回了非法着法"));
        return;
      }

      settled = true;
      finish();
      resolve({
        move: response.move,
        engine: "local",
        detail: `浏览器本地搜索 · ${response.depth} 层 · ${response.nodes} 节点`,
      });
    };

    const request: LocalRequest = { id, state, difficulty };
    worker.postMessage(request);
  });
}

/**
 * Chooses a legal Xiangqi move entirely in the browser. A hash-pinned real
 * Pikafish build is used only when every optional asset is present and the
 * page is cross-origin isolated; every other case uses the local worker.
 */
export async function chooseXiangqiMove(
  state: XiangqiState,
  difficulty: Difficulty,
  signal?: AbortSignal,
): Promise<XiangqiAiChoice> {
  if (signal?.aborted) throw abortError();

  const legalMoves = getLegalXiangqiMoves(state);
  if (state.status !== "playing" || legalMoves.length === 0) {
    throw new Error("当前局面没有可走的合法着法");
  }

  try {
    const pikafishMove = await chooseWithPikafish(state, difficulty, signal);
    if (pikafishMove && legalMoves.some((move) => sameMove(move, pikafishMove.move))) {
      return pikafishMove;
    }
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      throw abortError();
    }
    // Pikafish is an optional enhancement. Asset, browser, or engine failures
    // deliberately fall through to the guaranteed local worker.
  }

  return chooseLocally(state, difficulty, signal);
}
