import type { Difficulty } from "../../games/shared";
import {
  getLegalXiangqiMoves,
  playXiangqiMove,
  type XiangqiMove,
  type XiangqiPiece,
  type XiangqiState,
} from "../../games/xiangqi";

export interface LocalSearchResult {
  readonly move: XiangqiMove;
  readonly depth: number;
  readonly nodes: number;
}

interface SearchLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxCaptureDepth: number;
  readonly randomMargin: number;
}

interface SearchContext {
  nodes: number;
  readonly maxNodes: number;
}

interface ScoredMove {
  readonly move: XiangqiMove;
  readonly orderingScore: number;
}

interface RootCandidate {
  readonly move: XiangqiMove;
  readonly score: number;
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
  easy: { maxDepth: 3, maxNodes: 1_200, maxCaptureDepth: 2, randomMargin: 48 },
  normal: { maxDepth: 5, maxNodes: 12_000, maxCaptureDepth: 3, randomMargin: 24 },
  hard: { maxDepth: 7, maxNodes: 60_000, maxCaptureDepth: 4, randomMargin: 8 },
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

function chooseEquivalentRootMove(candidates: readonly RootCandidate[], randomMargin: number): XiangqiMove {
  let bestScore = -Infinity;
  for (const candidate of candidates) bestScore = Math.max(bestScore, candidate.score);

  const equivalent = candidates.filter((candidate) => candidate.score >= bestScore - randomMargin);
  if (equivalent.length === 1) return equivalent[0].move;

  let index: number;
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const randomValue = new Uint32Array(1);
    globalThis.crypto.getRandomValues(randomValue);
    index = randomValue[0] % equivalent.length;
  } else {
    index = Math.floor(Math.random() * equivalent.length);
  }
  return equivalent[index].move;
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

function quiescence(
  state: XiangqiState,
  alpha: number,
  beta: number,
  context: SearchContext,
  ply: number,
  remainingCaptureDepth: number,
): number {
  if (state.status !== "playing") {
    if (state.winner === null) return 0;
    return state.winner === state.turn ? MATE_SCORE - ply : -MATE_SCORE + ply;
  }

  const standPat = evaluate(state);
  if (remainingCaptureDepth === 0 || context.nodes >= context.maxNodes) return standPat;
  if (standPat >= beta) return standPat;

  let best = standPat;
  let lowerBound = Math.max(alpha, standPat);
  for (const move of orderedMoves(state)) {
    if (context.nodes >= context.maxNodes) break;
    if (!state.board[move.to.y]?.[move.to.x]) continue;

    const result = playXiangqiMove(state, move);
    if (!result.ok) continue;
    context.nodes += 1;

    const score = -quiescence(
      result.state,
      -beta,
      -lowerBound,
      context,
      ply + 1,
      remainingCaptureDepth - 1,
    );
    if (score > best) best = score;
    if (score > lowerBound) lowerBound = score;
    if (lowerBound >= beta) break;
  }
  return best;
}

function negamax(
  state: XiangqiState,
  depth: number,
  alpha: number,
  beta: number,
  context: SearchContext,
  ply: number,
  maxCaptureDepth: number,
): number {
  if (state.status !== "playing") {
    if (state.winner === null) return 0;
    return state.winner === state.turn ? MATE_SCORE - ply : -MATE_SCORE + ply;
  }
  if (depth === 0 || context.nodes >= context.maxNodes) {
    return quiescence(state, alpha, beta, context, ply, maxCaptureDepth);
  }

  context.nodes += 1;
  const moves = orderedMoves(state);
  if (moves.length === 0) return evaluate(state);

  let best = -Infinity;
  let lowerBound = alpha;
  for (const move of moves) {
    if (context.nodes >= context.maxNodes) break;
    const result = playXiangqiMove(state, move);
    if (!result.ok) continue;

    const score = -negamax(
      result.state,
      depth - 1,
      -beta,
      -lowerBound,
      context,
      ply + 1,
      maxCaptureDepth,
    );
    if (score > best) best = score;
    if (score > lowerBound) lowerBound = score;
    if (lowerBound >= beta) break;
  }
  return best === -Infinity ? evaluate(state) : best;
}

export function searchXiangqiLocally(state: XiangqiState, difficulty: Difficulty): LocalSearchResult {
  const limits = SEARCH_LIMITS[difficulty];
  const rootMoves = orderedMoves(state);
  if (rootMoves.length === 0) throw new Error("当前局面没有可走的合法着法");

  const context: SearchContext = { nodes: 0, maxNodes: limits.maxNodes };
  let bestMove = rootMoves[0];
  let completedDepth = 0;

  for (let depth = 1; depth <= limits.maxDepth; depth += 1) {
    const candidates: RootCandidate[] = [];
    let iterationScore = -Infinity;
    let completed = true;

    for (const move of rootMoves) {
      if (context.nodes >= context.maxNodes) {
        completed = false;
        break;
      }
      const result = playXiangqiMove(state, move);
      if (!result.ok) continue;
      const score = -negamax(
        result.state,
        depth - 1,
        -Infinity,
        Infinity,
        context,
        1,
        limits.maxCaptureDepth,
      );
      candidates.push({ move, score });
      iterationScore = Math.max(iterationScore, score);
    }

    if (!completed || candidates.length === 0) break;
    bestMove = chooseEquivalentRootMove(candidates, limits.randomMargin);
    completedDepth = depth;
    if (Math.abs(iterationScore) >= MATE_SCORE - 100 || context.nodes >= context.maxNodes) break;
  }

  return {
    move: bestMove,
    depth: Math.max(1, completedDepth),
    nodes: context.nodes,
  };
}
