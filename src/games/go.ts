export type GoColor = "black" | "white";

export interface GoMove {
  readonly x: number;
  readonly y: number;
}

export type GoStatus = "playing" | "finished";

export interface GoScore {
  readonly black: number;
  readonly white: number;
  readonly stones: Readonly<Record<GoColor, number>>;
  readonly territory: Readonly<Record<GoColor, number>>;
  readonly komi: 7.5;
  readonly winner: GoColor;
  readonly margin: number;
}

export interface GoState {
  readonly size: 9 | 13 | 19;
  readonly board: ReadonlyArray<ReadonlyArray<GoColor | null>>;
  readonly turn: GoColor;
  readonly status: GoStatus;
  readonly consecutivePasses: number;
  readonly captures: Readonly<Record<GoColor, number>>;
  readonly moveNumber: number;
  readonly lastMove: GoMove | "pass" | null;
  readonly history: readonly string[];
  readonly score: GoScore | null;
}

export type GoPlayResult =
  | { readonly ok: true; readonly state: GoState }
  | { readonly ok: false; readonly error: string };

const KOMI = 7.5 as const;
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function other(color: GoColor): GoColor {
  return color === "black" ? "white" : "black";
}

function inside(size: number, x: number, y: number): boolean {
  return x >= 0 && x < size && y >= 0 && y < size;
}

function cloneBoard(state: GoState): Array<Array<GoColor | null>> {
  return state.board.map((row) => [...row]);
}

function freezeBoard(board: Array<Array<GoColor | null>>): ReadonlyArray<ReadonlyArray<GoColor | null>> {
  for (const row of board) Object.freeze(row);
  return Object.freeze(board);
}

function serializeBoard(board: ReadonlyArray<ReadonlyArray<GoColor | null>>): string {
  return board
    .map((row) => row.map((cell) => (cell === "black" ? "b" : cell === "white" ? "w" : ".")).join(""))
    .join("/");
}

function collectGroup(
  board: ReadonlyArray<ReadonlyArray<GoColor | null>>,
  x: number,
  y: number,
): { stones: Array<GoMove>; liberties: Set<string> } {
  const color = board[y]?.[x];
  const stones: Array<GoMove> = [];
  const liberties = new Set<string>();
  if (!color) return { stones, liberties };

  const seen = new Set<string>();
  const pending: Array<GoMove> = [{ x, y }];
  while (pending.length > 0) {
    const point = pending.pop();
    if (!point) break;
    const key = `${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stones.push(point);

    for (const [dx, dy] of DIRECTIONS) {
      const nextX = point.x + dx;
      const nextY = point.y + dy;
      if (!inside(board.length, nextX, nextY)) continue;
      const cell = board[nextY][nextX];
      if (cell === null) liberties.add(`${nextX},${nextY}`);
      else if (cell === color && !seen.has(`${nextX},${nextY}`)) pending.push({ x: nextX, y: nextY });
    }
  }

  return { stones, liberties };
}

function makeState(state: Omit<GoState, "board" | "captures" | "history" | "lastMove" | "score"> & {
  board: Array<Array<GoColor | null>>;
  captures: Record<GoColor, number>;
  history: string[];
  lastMove: GoMove | "pass" | null;
  score: GoScore | null;
}): GoState {
  const lastMove = state.lastMove && state.lastMove !== "pass" ? Object.freeze({ ...state.lastMove }) : state.lastMove;
  return Object.freeze({
    ...state,
    board: freezeBoard(state.board),
    captures: Object.freeze({ ...state.captures }),
    history: Object.freeze([...state.history]),
    lastMove,
    score: state.score,
  });
}

export function createGoState(size: 9 | 13 | 19): GoState {
  const board = Array.from({ length: size }, () => Array<GoColor | null>(size).fill(null));
  return makeState({
    size,
    board,
    turn: "black",
    status: "playing",
    consecutivePasses: 0,
    captures: { black: 0, white: 0 },
    moveNumber: 0,
    lastMove: null,
    history: [serializeBoard(board)],
    score: null,
  });
}

export function getLegalGoMoves(state: GoState): GoMove[] {
  if (state.status !== "playing") return [];
  const moves: GoMove[] = [];
  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const result = playGoMove(state, { x, y });
      if (result.ok) moves.push(Object.freeze({ x, y }));
    }
  }
  return moves;
}

export function playGoMove(state: GoState, move: GoMove | "pass"): GoPlayResult {
  if (state.status !== "playing") {
    return { ok: false, error: "棋局已经结束，请复盘或重新开始。" };
  }

  if (move === "pass") {
    const consecutivePasses = state.consecutivePasses + 1;
    const finished = consecutivePasses >= 2;
    const board = cloneBoard(state);
    const nextBase = makeState({
      size: state.size,
      board,
      turn: other(state.turn),
      status: finished ? "finished" : "playing",
      consecutivePasses,
      captures: { ...state.captures },
      moveNumber: state.moveNumber + 1,
      lastMove: "pass",
      history: [...state.history, serializeBoard(board)],
      score: null,
    });
    if (!finished) return { ok: true, state: nextBase };
    const score = scoreGoGame(nextBase);
    return {
      ok: true,
      state: Object.freeze({ ...nextBase, score }),
    };
  }

  if (!Number.isInteger(move.x) || !Number.isInteger(move.y) || !inside(state.size, move.x, move.y)) {
    return { ok: false, error: "落子位置不在棋盘范围内。" };
  }
  if (state.board[move.y][move.x] !== null) {
    return { ok: false, error: "这个交叉点已经有棋子。" };
  }

  const board = cloneBoard(state);
  board[move.y][move.x] = state.turn;
  const opponent = other(state.turn);
  let captured = 0;
  const checkedGroups = new Set<string>();

  for (const [dx, dy] of DIRECTIONS) {
    const x = move.x + dx;
    const y = move.y + dy;
    if (!inside(state.size, x, y) || board[y][x] !== opponent) continue;
    const seed = `${x},${y}`;
    if (checkedGroups.has(seed)) continue;
    const group = collectGroup(board, x, y);
    for (const stone of group.stones) checkedGroups.add(`${stone.x},${stone.y}`);
    if (group.liberties.size !== 0) continue;
    captured += group.stones.length;
    for (const stone of group.stones) board[stone.y][stone.x] = null;
  }

  if (collectGroup(board, move.x, move.y).liberties.size === 0) {
    return { ok: false, error: "禁入点：这步会让己方棋块没有气。" };
  }

  const position = serializeBoard(board);
  if (state.history.includes(position)) {
    return { ok: false, error: "全局同形禁着：不能重复此前出现过的棋盘局面。" };
  }

  return {
    ok: true,
    state: makeState({
      size: state.size,
      board,
      turn: opponent,
      status: "playing",
      consecutivePasses: 0,
      captures: {
        ...state.captures,
        [state.turn]: state.captures[state.turn] + captured,
      },
      moveNumber: state.moveNumber + 1,
      lastMove: { x: move.x, y: move.y },
      history: [...state.history, position],
      score: null,
    }),
  };
}

export function scoreGoGame(state: GoState): GoScore {
  const stones: Record<GoColor, number> = { black: 0, white: 0 };
  const territory: Record<GoColor, number> = { black: 0, white: 0 };
  const visited = new Set<string>();

  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const cell = state.board[y][x];
      if (cell) {
        stones[cell] += 1;
        continue;
      }
      const startKey = `${x},${y}`;
      if (visited.has(startKey)) continue;

      const region: GoMove[] = [];
      const borders = new Set<GoColor>();
      const pending: GoMove[] = [{ x, y }];
      while (pending.length > 0) {
        const point = pending.pop();
        if (!point) break;
        const key = `${point.x},${point.y}`;
        if (visited.has(key)) continue;
        visited.add(key);
        region.push(point);
        for (const [dx, dy] of DIRECTIONS) {
          const nextX = point.x + dx;
          const nextY = point.y + dy;
          if (!inside(state.size, nextX, nextY)) continue;
          const neighbor = state.board[nextY][nextX];
          if (neighbor) borders.add(neighbor);
          else if (!visited.has(`${nextX},${nextY}`)) pending.push({ x: nextX, y: nextY });
        }
      }

      if (borders.size === 1) {
        const owner = borders.values().next().value;
        if (owner) territory[owner] += region.length;
      }
    }
  }

  const black = stones.black + territory.black;
  const white = stones.white + territory.white + KOMI;
  const winner: GoColor = black > white ? "black" : "white";
  return Object.freeze({
    black,
    white,
    stones: Object.freeze({ ...stones }),
    territory: Object.freeze({ ...territory }),
    komi: KOMI,
    winner,
    margin: Math.abs(black - white),
  });
}
