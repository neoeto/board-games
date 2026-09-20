/// <reference lib="webworker" />

import type { Difficulty } from "../../games/shared";
import {
  getLegalXiangqiMoves,
  playXiangqiMove,
  type XiangqiMove,
  type XiangqiPiece,
  type XiangqiState,
} from "../../games/xiangqi";

interface SearchRequest {
  readonly id: number;
  readonly state: XiangqiState;
  readonly difficulty: Difficulty;
}

interface SearchLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

interface SearchContext {
  nodes: number;
  readonly maxNodes: number;
}

interface ScoredMove {
  readonly move: XiangqiMove;
  readonly orderingScore: number;
}

const PIECE_VALUE: Readonly<Record<XiangqiPiece["type"], number>> = {
  king: 100_000,
  advisor: 220,
  elephant: 220,
  horse: 430,
  rook: 900,
  cannon: 480,
  pawn: 110,
};

const SEARCH_LIMITS: Readonly<Record<Difficulty, SearchLimits>> = {
  easy: { maxDepth: 2, maxNodes: 350 },
  normal: { maxDepth: 4, maxNodes: 8_000 },
  hard: { maxDepth: 6, maxNodes: 50_000 },
};

const MATE_SCORE = 1_000_000;

function compareMoves(left: ScoredMove, right: ScoredMove): number {
  if (left.orderingScore !== right.orderingScore) {
    return right.orderingScore - left.orderingScore;
  }
  return (
    left.move.from.y - right.move.from.y ||
    left.move.from.x - right.move.from.x ||
    left.move.to.y - right.move.to.y ||
    left.move.to.x - right.move.to.x
  );
}

function orderedMoves(state: XiangqiState): XiangqiMove[] {
  return getLegalXiangqiMoves(state)
    .map((move): ScoredMove => {
      const moving = state.board[move.from.y]?.[move.from.x] ?? null;
      const captured = state.board[move.to.y]?.[move.to.x] ?? null;
      const captureScore = captured
        ? PIECE_VALUE[captured.type] * 16 - (moving ? PIECE_VALUE[moving.type] : 0)
        : 0;
      const forward = moving?.side === "red" ? move.from.y - move.to.y : move.to.y - move.from.y;
      const central = 4 - Math.abs(4 - move.to.x);
      return { move, orderingScore: captureScore + forward * 3 + central };
    })
    .sort(compareMoves)
    .map(({ move }) => move);
}

function evaluate(state: XiangqiState): number {
  if (state.status !== "playing") {
    if (state.winner === null) return 0;
    return state.winner === state.turn ? MATE_SCORE : -MATE_SCORE;
  }

  let redScore = 0;
  let blackScore = 0;
  for (let y = 0; y < state.board.length; y += 1) {
    const row = state.board[y];
    for (let x = 0; x < row.length; x += 1) {
      const piece = row[x];
      if (!piece) continue;

      let value = PIECE_VALUE[piece.type];
      if (piece.type === "pawn") {
        const progress = piece.side === "red" ? 9 - y : y;
        value += progress * 8;
        if ((piece.side === "red" && y <= 4) || (piece.side === "black" && y >= 5)) {
          value += 35;
        }
      } else if (piece.type === "horse" || piece.type === "cannon") {
        value += (4 - Math.abs(4 - x)) * 4;
      }

      if (piece.side === "red") redScore += value;
      else blackScore += value;
    }
  }

  const redPerspective = redScore - blackScore;
  return state.turn === "red" ? redPerspective : -redPerspective;
}

function negamax(
  state: XiangqiState,
  depth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
  ply: number,
): number {
  context.nodes += 1;
  if (state.status !== "playing") {
    if (state.winner === null) return 0;
    return state.winner === state.turn ? MATE_SCORE - ply : -MATE_SCORE + ply;
  }
  if (depth === 0 || context.nodes >= context.maxNodes) return evaluate(state);

  const moves = orderedMoves(state);
  if (moves.length === 0) return evaluate(state);

  let best = -Infinity;
  let lowerBound = alpha;
  for (const move of moves) {
    if (context.nodes >= context.maxNodes) break;
    const result = playXiangqiMove(state, move);
    if (!result.ok) continue;

    const score = -negamax(result.state, depth - 1, -beta, -lowerBound, context, ply + 1);
    if (score > best) best = score;
    if (score > lowerBound) lowerBound = score;
    if (lowerBound >= beta) break;
  }
  return best === -Infinity ? evaluate(state) : best;
}

function search(state: XiangqiState, difficulty: Difficulty) {
  const limits = SEARCH_LIMITS[difficulty];
  const rootMoves = orderedMoves(state);
  if (rootMoves.length === 0) throw new Error("当前局面没有可走的合法着法");

  const context: SearchContext = { nodes: 0, maxNodes: limits.maxNodes };
  let bestMove = rootMoves[0];
  let completedDepth = 0;

  for (let depth = 1; depth <= limits.maxDepth; depth += 1) {
    let iterationBest = bestMove;
    let iterationScore = -Infinity;
    let completed = true;

    for (const move of rootMoves) {
      if (context.nodes >= context.maxNodes) {
        completed = false;
        break;
      }
      const result = playXiangqiMove(state, move);
      if (!result.ok) continue;
      const score = -negamax(result.state, depth - 1, -Infinity, Infinity, context, 1);
      if (score > iterationScore) {
        iterationScore = score;
        iterationBest = move;
      }
    }

    if (!completed) break;
    bestMove = iterationBest;
    completedDepth = depth;
    if (Math.abs(iterationScore) >= MATE_SCORE - 100 || context.nodes >= context.maxNodes) break;
  }

  return {
    move: bestMove,
    depth: Math.max(1, completedDepth),
    nodes: context.nodes,
  };
}

self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const { id, state, difficulty } = event.data;
  try {
    const result = search(state, difficulty);
    self.postMessage({ id, ok: true, ...result });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "本地象棋搜索失败",
    });
  }
};
