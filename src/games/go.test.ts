import assert from "node:assert/strict";
import test from "node:test";
import { playGoMove, type GoColor, type GoState } from "./go.ts";

function boardKey(board: GoState["board"]): string {
  return board
    .map((row) => row.map((cell) => (cell === "black" ? "b" : cell === "white" ? "w" : ".")).join(""))
    .join("/");
}

function fixture(
  stones: ReadonlyArray<readonly [number, number, GoColor]>,
  turn: GoColor = "black",
): GoState {
  const board = Array.from({ length: 9 }, () => Array<GoColor | null>(9).fill(null));
  for (const [x, y, color] of stones) board[y][x] = color;
  return {
    size: 9,
    board,
    turn,
    status: "playing",
    consecutivePasses: 0,
    captures: { black: 0, white: 0 },
    moveNumber: 0,
    lastMove: null,
    history: [boardKey(board)],
    score: null,
  };
}

test("a surrounded chain is removed and credited to the capturing color", () => {
  const state = fixture([
    [1, 1, "white"],
    [1, 0, "black"],
    [0, 1, "black"],
    [2, 1, "black"],
  ]);
  const result = playGoMove(state, { x: 1, y: 2 });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.board[1][1], null);
  assert.equal(result.state.captures.black, 1);
  assert.equal(state.board[1][1], "white", "the input snapshot remains unchanged");
});

test("suicide is rejected when placement captures nothing", () => {
  const state = fixture([
    [1, 0, "white"],
    [0, 1, "white"],
    [2, 1, "white"],
    [1, 2, "white"],
  ]);
  const result = playGoMove(state, { x: 1, y: 1 });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /没有气/);
});

test("an immediate ko recapture is rejected by positional repetition", () => {
  const state = fixture([
    [1, 1, "white"],
    [1, 0, "black"],
    [0, 1, "black"],
    [2, 1, "black"],
    [0, 2, "white"],
    [2, 2, "white"],
    [1, 3, "white"],
  ]);
  const capture = playGoMove(state, { x: 1, y: 2 });
  assert.equal(capture.ok, true);
  if (!capture.ok) return;

  const recapture = playGoMove(capture.state, { x: 1, y: 1 });
  assert.equal(recapture.ok, false);
  if (recapture.ok) return;
  assert.match(recapture.error, /同形/);
});

test("two passes finish and use Chinese area scoring with 7.5 komi", () => {
  const state = fixture([
    [1, 0, "black"],
    [0, 1, "black"],
    [2, 1, "black"],
    [1, 2, "black"],
    [8, 8, "white"],
  ]);
  const blackPass = playGoMove(state, "pass");
  assert.equal(blackPass.ok, true);
  if (!blackPass.ok) return;
  const whitePass = playGoMove(blackPass.state, "pass");
  assert.equal(whitePass.ok, true);
  if (!whitePass.ok) return;

  assert.equal(whitePass.state.status, "finished");
  assert.deepEqual(whitePass.state.score, {
    black: 6,
    white: 8.5,
    stones: { black: 4, white: 1 },
    territory: { black: 2, white: 0 },
    komi: 7.5,
    winner: "white",
    margin: 2.5,
  });
});
