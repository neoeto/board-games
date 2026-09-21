/// <reference lib="webworker" />

import type { Difficulty } from "../../games/shared";
import type { XiangqiState } from "../../games/xiangqi";
import { searchXiangqiLocally } from "./localSearch";

interface SearchRequest {
  readonly id: number;
  readonly state: XiangqiState;
  readonly difficulty: Difficulty;
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const { id, state, difficulty } = event.data;
  try {
    const result = searchXiangqiLocally(state, difficulty);
    self.postMessage({ id, ok: true, ...result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "本地象棋搜索失败",
    });
  }
};
