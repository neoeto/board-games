import type { CSSProperties, KeyboardEvent } from "react";
import type { GoMove, GoState } from "../games/go";

interface GoBoardProps {
  readonly state: GoState;
  readonly disabled: boolean;
  readonly onMove: (move: GoMove) => void;
}

function isStarPoint(size: GoState["size"], x: number, y: number): boolean {
  const marks = size === 9 ? [2, 4, 6] : size === 13 ? [3, 6, 9] : [3, 9, 15];
  if (!marks.includes(x) || !marks.includes(y)) return false;
  if (size === 9) return (x === 4 && y === 4) || (x !== 4 && y !== 4);
  return true;
}

function focusNeighbor(event: KeyboardEvent<HTMLButtonElement>, size: number, x: number, y: number): void {
  const movement: Record<string, readonly [number, number]> = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };
  const delta = movement[event.key];
  if (!delta) return;
  event.preventDefault();
  const nextX = Math.max(0, Math.min(size - 1, x + delta[0]));
  const nextY = Math.max(0, Math.min(size - 1, y + delta[1]));
  event.currentTarget.parentElement
    ?.querySelector<HTMLButtonElement>(`[data-point="${nextX}-${nextY}"]`)
    ?.focus();
}

export function GoBoard({ state, disabled, onMove }: GoBoardProps) {
  const cellSize = `${100 / (state.size - 1)}%`;
  const style = {
    "--go-size": state.size,
    "--go-cell": cellSize,
  } as CSSProperties;

  return (
    <div className="board-scroll" aria-label="围棋棋盘，可横向滚动">
      <div className={`go-surface go-size-${state.size}`} style={style}>
        <div className="go-grid" role="group" aria-label={`${state.size} 路围棋棋盘`}>
          <div className="go-playfield">
            {state.board.flatMap((row, y) =>
              row.map((stone, x) => {
                const isLast = state.lastMove !== null && state.lastMove !== "pass" && state.lastMove.x === x && state.lastMove.y === y;
                const stoneName = stone === "black" ? "黑子" : stone === "white" ? "白子" : "空位";
                return (
                  <button
                    aria-label={`第 ${x + 1} 列，第 ${y + 1} 行，${stoneName}${isLast ? "，上一手" : ""}`}
                    className={`go-point${isLast ? " is-last" : ""}`}
                    data-point={`${x}-${y}`}
                    style={{
                      left: `${(x / (state.size - 1)) * 100}%`,
                      top: `${(y / (state.size - 1)) * 100}%`,
                    }}
                    disabled={disabled}
                    key={`${x}-${y}`}
                    onClick={() => onMove({ x, y })}
                    onKeyDown={(event) => focusNeighbor(event, state.size, x, y)}
                    type="button"
                  >
                    {isStarPoint(state.size, x, y) && !stone ? <span className="star-point" aria-hidden="true" /> : null}
                    {stone ? <span className={`go-stone ${stone}`} aria-hidden="true" /> : null}
                    {isLast && stone ? <span className="last-marker" aria-hidden="true" /> : null}
                  </button>
                );
              }),
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
