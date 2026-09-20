export type XiangqiSide = "red" | "black";
export type XiangqiPieceType = "king" | "advisor" | "elephant" | "horse" | "rook" | "cannon" | "pawn";

export interface XiangqiPiece {
  readonly side: XiangqiSide;
  readonly type: XiangqiPieceType;
}

export interface XiangqiPosition {
  readonly x: number;
  readonly y: number;
}

export interface XiangqiMove {
  readonly from: XiangqiPosition;
  readonly to: XiangqiPosition;
}

export type XiangqiStatus = "playing" | "checkmate" | "stalemate" | "draw";

export interface XiangqiState {
  readonly board: ReadonlyArray<ReadonlyArray<XiangqiPiece | null>>;
  readonly turn: XiangqiSide;
  readonly status: XiangqiStatus;
  readonly winner: XiangqiSide | null;
  readonly moveNumber: number;
  readonly lastMove: XiangqiMove | null;
  readonly history: readonly string[];
}

export type XiangqiPlayResult =
  | { readonly ok: true; readonly state: XiangqiState }
  | { readonly ok: false; readonly error: string };

type MutableBoard = Array<Array<XiangqiPiece | null>>;

const PIECE_CODE: Record<XiangqiPieceType, string> = {
  king: "k",
  advisor: "a",
  elephant: "e",
  horse: "h",
  rook: "r",
  cannon: "c",
  pawn: "p",
};

const ORTHOGONAL_DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function opposite(side: XiangqiSide): XiangqiSide {
  return side === "red" ? "black" : "red";
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < 9 && y >= 0 && y < 10;
}

function inPalace(side: XiangqiSide, x: number, y: number): boolean {
  if (x < 3 || x > 5) return false;
  return side === "red" ? y >= 7 && y <= 9 : y >= 0 && y <= 2;
}

function cloneBoard(board: XiangqiState["board"]): MutableBoard {
  return board.map((row) => [...row]);
}

function freezeBoard(board: MutableBoard): XiangqiState["board"] {
  for (const row of board) {
    for (let x = 0; x < row.length; x += 1) {
      const piece = row[x];
      if (piece && !Object.isFrozen(piece)) row[x] = Object.freeze({ ...piece });
    }
    Object.freeze(row);
  }
  return Object.freeze(board);
}

function serializePosition(board: XiangqiState["board"], turn: XiangqiSide): string {
  const rows = board.map((row) =>
    row
      .map((piece) => {
        if (!piece) return ".";
        const code = PIECE_CODE[piece.type];
        return piece.side === "red" ? code.toUpperCase() : code;
      })
      .join(""),
  );
  return `${turn}|${rows.join("/")}`;
}

function freezeMove(move: XiangqiMove | null): XiangqiMove | null {
  if (!move) return null;
  return Object.freeze({
    from: Object.freeze({ ...move.from }),
    to: Object.freeze({ ...move.to }),
  });
}

function makeState(input: {
  board: MutableBoard;
  turn: XiangqiSide;
  status: XiangqiStatus;
  winner: XiangqiSide | null;
  moveNumber: number;
  lastMove: XiangqiMove | null;
  history: string[];
}): XiangqiState {
  return Object.freeze({
    ...input,
    board: freezeBoard(input.board),
    lastMove: freezeMove(input.lastMove),
    history: Object.freeze([...input.history]),
  });
}

function countBetween(board: XiangqiState["board"], from: XiangqiPosition, to: XiangqiPosition): number {
  const stepX = Math.sign(to.x - from.x);
  const stepY = Math.sign(to.y - from.y);
  let x = from.x + stepX;
  let y = from.y + stepY;
  let count = 0;
  while (x !== to.x || y !== to.y) {
    if (board[y][x]) count += 1;
    x += stepX;
    y += stepY;
  }
  return count;
}

function canPieceReach(
  board: XiangqiState["board"],
  piece: XiangqiPiece,
  from: XiangqiPosition,
  to: XiangqiPosition,
  forAttack = false,
): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const absX = Math.abs(dx);
  const absY = Math.abs(dy);
  const target = board[to.y][to.x];

  switch (piece.type) {
    case "rook":
      return (dx === 0 || dy === 0) && countBetween(board, from, to) === 0;
    case "cannon": {
      if (dx !== 0 && dy !== 0) return false;
      const screens = countBetween(board, from, to);
      if (forAttack) return target !== null && screens === 1;
      return target ? screens === 1 : screens === 0;
    }
    case "horse": {
      if (!((absX === 2 && absY === 1) || (absX === 1 && absY === 2))) return false;
      const legX = absX === 2 ? from.x + Math.sign(dx) : from.x;
      const legY = absY === 2 ? from.y + Math.sign(dy) : from.y;
      return board[legY][legX] === null;
    }
    case "elephant": {
      if (absX !== 2 || absY !== 2) return false;
      if (piece.side === "red" ? to.y < 5 : to.y > 4) return false;
      return board[from.y + dy / 2][from.x + dx / 2] === null;
    }
    case "advisor":
      return absX === 1 && absY === 1 && inPalace(piece.side, to.x, to.y);
    case "king": {
      if (target?.type === "king" && target.side !== piece.side && dx === 0) {
        return countBetween(board, from, to) === 0;
      }
      return absX + absY === 1 && inPalace(piece.side, to.x, to.y);
    }
    case "pawn": {
      const forward = piece.side === "red" ? -1 : 1;
      if (dx === 0 && dy === forward) return true;
      const crossedRiver = piece.side === "red" ? from.y <= 4 : from.y >= 5;
      return crossedRiver && absX === 1 && dy === 0;
    }
  }
}

function findKing(board: XiangqiState["board"], side: XiangqiSide): XiangqiPosition | null {
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const piece = board[y][x];
      if (piece?.side === side && piece.type === "king") return { x, y };
    }
  }
  return null;
}

function squareIsAttacked(
  board: XiangqiState["board"],
  square: XiangqiPosition,
  attackingSide: XiangqiSide,
): boolean {
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 9; x += 1) {
      const piece = board[y][x];
      if (!piece || piece.side !== attackingSide) continue;
      if (canPieceReach(board, piece, { x, y }, square, true)) return true;
    }
  }
  return false;
}

function applyMove(board: XiangqiState["board"], move: XiangqiMove): MutableBoard {
  const next = board.map((row) => [...row]);
  next[move.to.y][move.to.x] = next[move.from.y][move.from.x];
  next[move.from.y][move.from.x] = null;
  return next;
}

export function isXiangqiInCheck(state: Pick<XiangqiState, "board">, side: XiangqiSide): boolean {
  const king = findKing(state.board, side);
  return king === null || squareIsAttacked(state.board, king, opposite(side));
}

function legalMovesForBoard(board: XiangqiState["board"], side: XiangqiSide): XiangqiMove[] {
  const moves: XiangqiMove[] = [];
  for (let fromY = 0; fromY < 10; fromY += 1) {
    for (let fromX = 0; fromX < 9; fromX += 1) {
      const piece = board[fromY][fromX];
      if (!piece || piece.side !== side) continue;
      for (let toY = 0; toY < 10; toY += 1) {
        for (let toX = 0; toX < 9; toX += 1) {
          if (fromX === toX && fromY === toY) continue;
          const target = board[toY][toX];
          if (target?.side === side) continue;
          const from = { x: fromX, y: fromY };
          const to = { x: toX, y: toY };
          if (!canPieceReach(board, piece, from, to)) continue;
          const nextBoard = applyMove(board, { from, to });
          const ownKing = findKing(nextBoard, side);
          if (!ownKing || squareIsAttacked(nextBoard, ownKing, opposite(side))) continue;
          moves.push(Object.freeze({
            from: Object.freeze(from),
            to: Object.freeze(to),
          }));
        }
      }
    }
  }
  return moves;
}

export function createXiangqiState(): XiangqiState {
  const board = Array.from({ length: 10 }, () => Array<XiangqiPiece | null>(9).fill(null));
  const backRank: readonly XiangqiPieceType[] = [
    "rook",
    "horse",
    "elephant",
    "advisor",
    "king",
    "advisor",
    "elephant",
    "horse",
    "rook",
  ];
  for (let x = 0; x < 9; x += 1) {
    board[0][x] = { side: "black", type: backRank[x] };
    board[9][x] = { side: "red", type: backRank[x] };
  }
  board[2][1] = { side: "black", type: "cannon" };
  board[2][7] = { side: "black", type: "cannon" };
  board[7][1] = { side: "red", type: "cannon" };
  board[7][7] = { side: "red", type: "cannon" };
  for (const x of [0, 2, 4, 6, 8]) {
    board[3][x] = { side: "black", type: "pawn" };
    board[6][x] = { side: "red", type: "pawn" };
  }
  return makeState({
    board,
    turn: "red",
    status: "playing",
    winner: null,
    moveNumber: 0,
    lastMove: null,
    history: [serializePosition(board, "red")],
  });
}

export function getLegalXiangqiMoves(state: XiangqiState): XiangqiMove[] {
  if (state.status !== "playing") return [];
  return legalMovesForBoard(state.board, state.turn);
}

export function playXiangqiMove(state: XiangqiState, move: XiangqiMove): XiangqiPlayResult {
  if (state.status !== "playing") {
    return { ok: false, error: "棋局已经结束，请复盘或重新开始。" };
  }
  const { from, to } = move;
  if (
    !Number.isInteger(from.x) ||
    !Number.isInteger(from.y) ||
    !Number.isInteger(to.x) ||
    !Number.isInteger(to.y) ||
    !inBounds(from.x, from.y) ||
    !inBounds(to.x, to.y)
  ) {
    return { ok: false, error: "走子坐标不在棋盘范围内。" };
  }
  const piece = state.board[from.y][from.x];
  if (!piece) return { ok: false, error: "起点没有棋子。" };
  if (piece.side !== state.turn) return { ok: false, error: "现在不能移动对方棋子。" };
  if (state.board[to.y][to.x]?.side === state.turn) {
    return { ok: false, error: "终点已有己方棋子。" };
  }

  const legalMove = legalMovesForBoard(state.board, state.turn).find(
    (candidate) =>
      candidate.from.x === from.x &&
      candidate.from.y === from.y &&
      candidate.to.x === to.x &&
      candidate.to.y === to.y,
  );
  if (!legalMove) {
    return { ok: false, error: "这步不符合棋子走法，或会让己方将帅受将。" };
  }

  const board = applyMove(state.board, legalMove);
  const nextTurn = opposite(state.turn);
  const position = serializePosition(board, nextTurn);
  const history = [...state.history, position];
  const replies = legalMovesForBoard(board, nextTurn);
  let status: XiangqiStatus = "playing";
  let winner: XiangqiSide | null = null;

  if (replies.length === 0) {
    status = isXiangqiInCheck({ board }, nextTurn) ? "checkmate" : "stalemate";
    winner = state.turn;
  } else if (history.filter((entry) => entry === position).length >= 3) {
    status = "draw";
  }

  return {
    ok: true,
    state: makeState({
      board,
      turn: nextTurn,
      status,
      winner,
      moveNumber: state.moveNumber + 1,
      lastMove: legalMove,
      history,
    }),
  };
}
