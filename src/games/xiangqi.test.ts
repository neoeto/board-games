import assert from "node:assert/strict";
import test from "node:test";
import {
  getLegalXiangqiMoves,
  playXiangqiMove,
  type XiangqiPiece,
  type XiangqiSide,
  type XiangqiState,
} from "./xiangqi.ts";

type PlacedPiece = readonly [number, number, XiangqiSide, XiangqiPiece["type"]];

function fixture(pieces: readonly PlacedPiece[], turn: XiangqiSide = "red"): XiangqiState {
  const board = Array.from({ length: 10 }, () => Array<XiangqiPiece | null>(9).fill(null));
  for (const [x, y, side, type] of pieces) board[y][x] = { side, type };
  return {
    board,
    turn,
    status: "playing",
    winner: null,
    moveNumber: 0,
    lastMove: null,
    history: ["fixture-position"],
  };
}

function hasMove(state: XiangqiState, fromX: number, fromY: number, toX: number, toY: number): boolean {
  return getLegalXiangqiMoves(state).some(
    (move) => move.from.x === fromX && move.from.y === fromY && move.to.x === toX && move.to.y === toY,
  );
}

test("a horse cannot jump through an occupied horse leg", () => {
  const state = fixture([
    [4, 0, "black", "king"],
    [4, 9, "red", "king"],
    [4, 5, "red", "pawn"],
    [1, 9, "red", "horse"],
    [2, 9, "red", "pawn"],
  ]);

  assert.equal(hasMove(state, 1, 9, 3, 8), false);
});

test("a cannon capture requires exactly one screen", () => {
  const state = fixture([
    [4, 0, "black", "king"],
    [4, 9, "red", "king"],
    [4, 5, "red", "pawn"],
    [0, 7, "red", "cannon"],
    [0, 5, "red", "pawn"],
    [0, 2, "black", "rook"],
  ]);

  assert.equal(hasMove(state, 0, 7, 0, 2), true);
  assert.equal(hasMove(state, 0, 7, 0, 1), false, "a cannon cannot land on an empty square beyond a screen");
});

test("flying generals can capture across an open file", () => {
  const state = fixture([
    [4, 0, "black", "king"],
    [4, 9, "red", "king"],
  ]);

  assert.equal(hasMove(state, 4, 9, 4, 0), true);
});

test("moving the sole screen between generals is rejected as self-check", () => {
  const state = fixture([
    [4, 0, "black", "king"],
    [4, 9, "red", "king"],
    [4, 5, "red", "rook"],
  ]);

  assert.equal(hasMove(state, 4, 5, 3, 5), false);
  const result = playXiangqiMove(state, { from: { x: 4, y: 5 }, to: { x: 3, y: 5 } });
  assert.equal(result.ok, false);
});

test("a boxed and checked general is recorded as checkmate", () => {
  const state = fixture([
    [4, 0, "black", "king"],
    [4, 9, "red", "king"],
    [3, 1, "red", "rook"],
    [5, 1, "red", "rook"],
    [4, 2, "red", "rook"],
  ]);
  const result = playXiangqiMove(state, { from: { x: 4, y: 2 }, to: { x: 4, y: 1 } });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.status, "checkmate");
  assert.equal(result.state.winner, "red");
  assert.equal(getLegalXiangqiMoves(result.state).length, 0);
});
