import { useMemo, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  getLegalXiangqiMoves,
  type XiangqiMove,
  type XiangqiPiece,
  type XiangqiPosition,
  type XiangqiState,
} from "../games/xiangqi";

interface XiangqiBoardProps {
  readonly state: XiangqiState;
  readonly disabled: boolean;
  readonly onMove: (move: XiangqiMove) => boolean;
  readonly onMessage: (message: string) => void;
}

const RED_LABELS: Record<XiangqiPiece["type"], string> = {
  king: "帥",
  advisor: "仕",
  elephant: "相",
  horse: "馬",
  rook: "俥",
  cannon: "炮",
  pawn: "兵",
};

const BLACK_LABELS: Record<XiangqiPiece["type"], string> = {
  king: "將",
  advisor: "士",
  elephant: "象",
  horse: "馬",
  rook: "車",
  cannon: "砲",
  pawn: "卒",
};

function samePosition(left: XiangqiPosition | null, right: XiangqiPosition): boolean {
  return left !== null && left.x === right.x && left.y === right.y;
}

function focusNeighbor(event: KeyboardEvent<HTMLButtonElement>, x: number, y: number): void {
  const movement: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = movement[event.key];
  if (!delta) return;
  event.preventDefault();
  const nextX = Math.max(0, Math.min(8, x + delta[0]));
  const nextY = Math.max(0, Math.min(9, y + delta[1]));
  event.currentTarget.parentElement
    ?.querySelector<HTMLButtonElement>(`[data-square="${nextX}-${nextY}"]`)
    ?.focus();
}

export function XiangqiBoard({ state, disabled, onMove, onMessage }: XiangqiBoardProps) {
  const [selected, setSelected] = useState<XiangqiPosition | null>(null);
  const targets = useMemo(() => {
    if (!selected) return new Set<string>();
    return new Set(
      getLegalXiangqiMoves(state)
        .filter((move) => samePosition(selected, move.from))
        .map((move) => `${move.to.x}-${move.to.y}`),
    );
  }, [selected, state]);

  function handleSquare(position: XiangqiPosition): void {
    const piece = state.board[position.y][position.x];
    if (!selected) {
      if (!piece) {
        onMessage("请先选择一枚红方棋子。");
        return;
      }
      if (piece.side !== "red") {
        onMessage("你执红方，请选择红方棋子。");
        return;
      }
      setSelected(position);
      onMessage(`已选择${RED_LABELS[piece.type]}，请选择落点。`);
      return;
    }

    if (piece?.side === "red") {
      setSelected(position);
      onMessage(`已改选${RED_LABELS[piece.type]}，请选择落点。`);
      return;
    }

    const moved = onMove({ from: selected, to: position });
    if (moved) setSelected(null);
  }

  return (
    <div className="board-scroll" aria-label="中国象棋棋盘，可横向滚动">
      <div className="xiangqi-surface">
        <div className="palace-lines" aria-hidden="true" />
        <div className="river" aria-hidden="true"><span>楚河</span><span>漢界</span></div>
        <div className="xiangqi-grid" role="group" aria-label="中国象棋棋盘，红方在下">
          {state.board.flatMap((row, y) =>
            row.map((piece, x) => {
              const position = { x, y };
              const isSelected = samePosition(selected, position);
              const isTarget = targets.has(`${x}-${y}`);
              const isLastFrom = samePosition(state.lastMove?.from ?? null, position);
              const isLastTo = samePosition(state.lastMove?.to ?? null, position);
              const arrivalStyle = isLastTo && state.lastMove
                ? {
                    "--move-x": `${(state.lastMove.from.x - x) * 125}%`,
                    "--move-y": `${(state.lastMove.from.y - y) * 125}%`,
                  } as CSSProperties
                : undefined;
              const label = piece
                ? `${piece.side === "red" ? "红方" : "黑方"}${piece.side === "red" ? RED_LABELS[piece.type] : BLACK_LABELS[piece.type]}`
                : "空位";
              return (
                <button
                  aria-label={`第 ${x + 1} 路，第 ${10 - y} 线，${label}${isSelected ? "，已选择" : ""}${isTarget ? "，可走" : ""}`}
                  aria-pressed={isSelected}
                  className={`xiangqi-square${isSelected ? " is-selected" : ""}${isTarget ? " is-target" : ""}${isLastFrom || isLastTo ? " is-last" : ""}`}
                  data-square={`${x}-${y}`}
                  style={{
                    left: `${(x / 8) * 100}%`,
                    top: `${(y / 9) * 100}%`,
                  }}
                  disabled={disabled}
                  key={`${x}-${y}`}
                  onClick={() => handleSquare(position)}
                  onKeyDown={(event) => focusNeighbor(event, x, y)}
                  type="button"
                >
                  {piece ? (
                    <span
                      className={`xiangqi-piece ${piece.side}${isLastTo ? " is-arriving" : ""}`}
                      aria-hidden="true"
                      style={arrivalStyle}
                    >
                      {piece.side === "red" ? RED_LABELS[piece.type] : BLACK_LABELS[piece.type]}
                    </span>
                  ) : null}
                </button>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}
