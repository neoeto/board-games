import type { GoColor, GoMove, GoState } from "../games/go";
import type { XiangqiMove, XiangqiSide, XiangqiState } from "../games/xiangqi";

export const ROOM_SOCKET_PROTOCOL = "game-room-v1";
export const ROOM_SEAT_PROTOCOL_PREFIX = "seat.";

export type OnlineGameId = "go" | "xiangqi";
export type OnlineSide = GoColor | XiangqiSide;
export type OnlineGameState = GoState | XiangqiState;
export type RoomPhase = "waiting" | "playing" | "finished" | "abandoned" | "expired";
export type RoomOutcomeReason = "rule" | "resignation" | "disconnect" | "abandoned" | "expired";

export interface RoomConfiguration {
  readonly game: OnlineGameId;
  readonly goSize: 9 | 13 | 19 | null;
  readonly hostSide: OnlineSide;
}

export interface RoomSeat {
  readonly side: OnlineSide;
  readonly connected: boolean;
}

export interface RoomOutcome {
  readonly winner: OnlineSide | null;
  readonly reason: RoomOutcomeReason;
}

export interface RoomSnapshot {
  readonly configuration: RoomConfiguration;
  readonly phase: RoomPhase;
  readonly gameState: OnlineGameState;
  readonly seats: readonly [RoomSeat, RoomSeat | null];
  readonly deadlineAt: number | null;
  readonly disconnectedSide: OnlineSide | null;
  readonly outcome: RoomOutcome | null;
}

export interface RoomSeatSession {
  readonly token: string;
  readonly side: OnlineSide;
}

export interface CreateRoomResponse {
  readonly roomId: string;
  readonly seat: RoomSeatSession;
  readonly snapshot: RoomSnapshot;
}

export interface JoinRoomResponse {
  readonly seat: RoomSeatSession;
  readonly snapshot: RoomSnapshot;
}


export interface RoomPreview {
  readonly configuration: RoomConfiguration;
  readonly waitingExpiresAt: number;
}
export type RoomClientMessage =
  | { readonly type: "sync" }
  | { readonly type: "move"; readonly move: GoMove | XiangqiMove }
  | { readonly type: "pass" }
  | { readonly type: "resign" };

export type RoomServerMessage =
  | { readonly type: "snapshot"; readonly snapshot: RoomSnapshot }
  | { readonly type: "error"; readonly message: string };

export function isGoConfiguration(configuration: RoomConfiguration): boolean {
  return configuration.game === "go";
}

export function isGoMove(move: GoMove | XiangqiMove): move is GoMove {
  return "x" in move && "y" in move;
}

export function isXiangqiMove(move: GoMove | XiangqiMove): move is XiangqiMove {
  return "from" in move && "to" in move;
}
