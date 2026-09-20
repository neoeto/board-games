import type { Difficulty } from "../../games/shared";
import {
  getLegalGoMoves,
  playGoMove,
  type GoColor,
  type GoMove,
  type GoState,
} from "../../games/go";

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

type SearchReply =
  | {
      readonly id: number;
      readonly ok: true;
      readonly move: GoMove | "pass";
      readonly nodes: number;
      readonly budget: number;
      readonly depth: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

type SearchConfig = {
  readonly maxNodes: number;
  readonly depth: number;
  readonly branches: readonly number[];
};

type SearchContext = {
  readonly id: number;
  readonly root: GoColor;
  readonly config: SearchConfig;
  nodes: number;
};

const SEARCH_CONFIG: Record<Difficulty, SearchConfig> = {
  easy: { maxNodes: 72, depth: 1, branches: [16] },
  normal: { maxNodes: 560, depth: 2, branches: [28, 12] },
  hard: { maxNodes: 3_200, depth: 3, branches: [48, 14, 6] },
};
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;


const cancelled = new Set<number>();

function opposite(color: GoColor): GoColor {
  return color === "black" ? "white" : "black";
}

function moveIndex(move: GoMove | "pass", size: number): number {
  return move === "pass" ? size * size : move.y * size + move.x;
}

function positionSeed(state: GoState): number {
  let hash = 2166136261;
  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const stone = state.board[y]?.[x];
      hash ^= stone === "black" ? 1 : stone === "white" ? 2 : 0;
      hash = Math.imul(hash, 16777619);
    }
  }
  return (hash ^ state.moveNumber) >>> 0;
}

function tieBreak(move: GoMove | "pass", size: number, seed: number): number {
  let value = (seed ^ Math.imul(moveIndex(move, size) + 1, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  return value >>> 0;
}


function moveShapeScore(state: GoState, move: GoMove | "pass"): number {
  if (move === "pass") {
    const empty = state.board.reduce(
      (total, row) => total + row.reduce((count, cell) => count + (cell === null ? 1 : 0), 0),
      0,
    );
    return state.consecutivePasses > 0 ? 20 - empty * 0.05 : -40 - empty * 0.1;
  }

  const enemy = opposite(state.turn);
  let score = 0;
  for (const [dx, dy] of DIRECTIONS) {
    const nx = move.x + dx;
    const ny = move.y + dy;
    if (nx < 0 || nx >= state.size || ny < 0 || ny >= state.size) continue;
    const stone = state.board[ny]?.[nx];
    if (stone === enemy) score += 7;
    else if (stone === state.turn) score += 2.5;
    else score += 1.5;
  }

  const center = (state.size - 1) / 2;
  const distance = Math.abs(move.x - center) + Math.abs(move.y - center);
  score += Math.max(0, state.size * 0.35 - distance) * (state.moveNumber < state.size ? 1.4 : 0.25);

  const edgeDistance = Math.min(move.x, move.y, state.size - 1 - move.x, state.size - 1 - move.y);
  if (state.moveNumber < state.size * 1.5 && edgeDistance === 0) score -= 4;
  return score;
}

function orderedMoves(state: GoState, limit: number): readonly (GoMove | "pass")[] {
  const moves: (GoMove | "pass")[] = [...getLegalGoMoves(state)];
  if (moves.length === 0 || state.consecutivePasses > 0 || state.moveNumber > state.size * state.size * 0.55) {
    moves.push("pass");
  }

  const seed = positionSeed(state);
  moves.sort((left, right) => {
    const shape = moveShapeScore(state, right) - moveShapeScore(state, left);
    if (Math.abs(shape) > 1e-9) return shape;
    return tieBreak(left, state.size, seed) - tieBreak(right, state.size, seed);
  });
  return moves.slice(0, limit);
}

function evaluatePosition(state: GoState, root: GoColor): number {
  if (state.status === "finished" && state.score) {
    return state.score.winner === root ? 100_000 + state.score.margin * 100 : -100_000 - state.score.margin * 100;
  }

  let blackStones = 0;
  let whiteStones = 0;
  let blackInfluence = 0;
  let whiteInfluence = 0;
  let blackLiberties = 0;
  let whiteLiberties = 0;

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const stone = state.board[y]?.[x] ?? null;
      if (stone === "black") blackStones += 1;
      else if (stone === "white") whiteStones += 1;

      let liberties = 0;
      let seesBlack = false;
      let seesWhite = false;
      for (const [dx, dy] of DIRECTIONS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= state.size || ny < 0 || ny >= state.size) continue;
        const adjacentStone = state.board[ny]?.[nx] ?? null;
        if (adjacentStone === null) liberties += 1;
        else if (adjacentStone === "black") seesBlack = true;
        else seesWhite = true;
      }
      if (stone === "black") blackLiberties += liberties;
      else if (stone === "white") whiteLiberties += liberties;
      else {
        if (seesBlack && !seesWhite) blackInfluence += 1;
        if (seesWhite && !seesBlack) whiteInfluence += 1;
      }
    }
  }

  const black =
    blackStones * 4 + blackInfluence * 1.25 + blackLiberties * 0.32 + state.captures.black * 5;
  const white =
    whiteStones * 4 + whiteInfluence * 1.25 + whiteLiberties * 0.32 + state.captures.white * 5 + 7.5;
  return root === "black" ? black - white : white - black;
}

function abortError(): Error {
  const error = new Error("Go search cancelled");
  error.name = "AbortError";
  return error;
}

async function checkpoint(context: SearchContext): Promise<void> {
  if (cancelled.has(context.id)) throw abortError();
  if ((context.nodes & 31) === 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (cancelled.has(context.id)) throw abortError();
  }
}

async function searchNode(
  state: GoState,
  depth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
): Promise<number> {
  if (depth <= 0 || state.status === "finished" || context.nodes >= context.config.maxNodes) {
    return evaluatePosition(state, context.root);
  }

  const branchIndex = Math.min(context.config.depth - depth, context.config.branches.length - 1);
  const moves = orderedMoves(state, context.config.branches[branchIndex] ?? 1);
  if (moves.length === 0) return evaluatePosition(state, context.root);

  const maximizing = state.turn === context.root;
  let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const move of moves) {
    if (context.nodes >= context.config.maxNodes) break;
    context.nodes += 1;
    await checkpoint(context);
    const played = playGoMove(state, move);
    if (!played.ok) continue;
    const value = await searchNode(played.state, depth - 1, alpha, beta, context);
    if (maximizing) {
      best = Math.max(best, value);
      alpha = Math.max(alpha, best);
    } else {
      best = Math.min(best, value);
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }

  return Number.isFinite(best) ? best : evaluatePosition(state, context.root);
}

async function chooseMove(request: SearchRequest): Promise<SearchReply> {
  const config = SEARCH_CONFIG[request.difficulty];
  const context: SearchContext = {
    id: request.id,
    root: request.state.turn,
    config,
    nodes: 0,
  };

  if (request.state.status === "finished") {
    return { id: request.id, ok: true, move: "pass", nodes: 0, budget: config.maxNodes, depth: config.depth };
  }

  const rootMoves = orderedMoves(request.state, config.branches[0] ?? 1);
  if (rootMoves.length === 0) {
    return { id: request.id, ok: true, move: "pass", nodes: 0, budget: config.maxNodes, depth: config.depth };
  }

  let bestMove: GoMove | "pass" = rootMoves[0] ?? "pass";
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const move of rootMoves) {
    if (context.nodes >= config.maxNodes) break;
    context.nodes += 1;
    await checkpoint(context);
    const played = playGoMove(request.state, move);
    if (!played.ok) continue;
    const score = await searchNode(
      played.state,
      config.depth - 1,
      Number.NEGATIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      context,
    );
    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  return {
    id: request.id,
    ok: true,
    move: bestMove,
    nodes: context.nodes,
    budget: config.maxNodes,
    depth: config.depth,
  };
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelled.add(request.id);
    return;
  }

  void chooseMove(request)
    .then((reply) => {
      if (!cancelled.has(request.id)) self.postMessage(reply);
    })
    .catch((error: unknown) => {
      if (!cancelled.has(request.id)) {
        self.postMessage({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies SearchReply);
      }
    })
    .finally(() => cancelled.delete(request.id));
};
