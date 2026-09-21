import type { Difficulty } from "../../games/shared";
import type { GoState } from "../../games/go";
import { searchLocalGo } from "./localSearch";

type SearchRequest = {
  readonly type: "search";
  readonly id: number;
  readonly state: GoState;
  readonly difficulty: Difficulty;
};

type CancelRequest = {
  readonly type: "cancel";
  readonly id: number;
};

type WorkerRequest = SearchRequest | CancelRequest;

const cancelled = new Set<number>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }

  void searchLocalGo(request.state, request.difficulty, () => cancelled.has(request.id))
    .then((result) => {
      if (!cancelled.has(request.id)) {
        self.postMessage({ id: request.id, ok: true, ...result });
      }
    })
    .catch((error: unknown) => {
      if (!cancelled.has(request.id)) {
        self.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })
    .finally(() => cancelled.delete(request.id));
};
