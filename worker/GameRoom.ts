import { DurableObject } from "cloudflare:workers";
import { ACTIVE_ROOM_REGISTRY_NAME } from "./ActiveRoomRegistry";

import {
  createGoState,
  playGoMove,
  type GoMove,
  type GoState,
} from "../src/games/go";
import {
  createXiangqiState,
  playXiangqiMove,
  type XiangqiMove,
  type XiangqiState,
} from "../src/games/xiangqi";
import {
  type CreateRoomResponse,
  type JoinRoomResponse,
  type OnlineGameState,
  type OnlineSide,
  type RoomClientMessage,
  type RoomConfiguration,
  type RoomOutcome,
  type RoomPhase,
  type RoomPreview,
  type RoomSeatSession,
  type RoomServerMessage,
  type RoomSnapshot,
} from "../src/online/protocol";

const ROOM_KEY = "room";
const WAITING_ROOM_DURATION_MS = 15 * 60 * 1_000;
const DISCONNECT_GRACE_MS = 2 * 60 * 1_000;
const POSTGAME_DURATION_MS = 15 * 60 * 1_000;
const MAX_CLIENT_MESSAGE_BYTES = 8_192;
const CAPACITY_RELEASE_RETRY_MS = 30_000;

interface StoredSeat extends RoomSeatSession {}

interface StoredRoom {
  readonly roomId: string | null;
  readonly capacityReleased: boolean;
  readonly capacityReleaseRetryAt: number | null;
  readonly configuration: RoomConfiguration;
  readonly gameState: OnlineGameState;
  readonly seats: readonly [StoredSeat, StoredSeat | null];
  readonly phase: RoomPhase;
  readonly waitingExpiresAt: number | null;
  readonly disconnectExpiresAt: number | null;
  readonly disconnectedSide: OnlineSide | null;
  readonly postgameExpiresAt: number | null;
  readonly outcome: RoomOutcome | null;
}

interface CreateRoomRequest {
  readonly game: "go" | "xiangqi";
  readonly goSize?: 9 | 13 | 19;
  readonly hostSide: OnlineSide;
}

interface SocketAttachment {
  readonly token: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function randomToken(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function otherSide(configuration: RoomConfiguration): OnlineSide {
  if (configuration.game === "go") {
    return configuration.hostSide === "black" ? "white" : "black";
  }
  return configuration.hostSide === "red" ? "black" : "red";
}

function isSideForGame(game: RoomConfiguration["game"], side: unknown): side is OnlineSide {
  return game === "go"
    ? side === "black" || side === "white"
    : side === "red" || side === "black";
}

function parseCreateRequest(value: unknown): CreateRoomRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const game = candidate.game;
  const hostSide = candidate.hostSide;
  if (game !== "go" && game !== "xiangqi") return null;
  if (!isSideForGame(game, hostSide)) return null;
  if (game === "xiangqi") {
    return candidate.goSize === undefined ? { game, hostSide } : null;
  }
  const goSize = candidate.goSize;
  if (goSize !== 9 && goSize !== 13 && goSize !== 19) return null;
  return { game, hostSide, goSize };
}

function attachmentFor(socket: WebSocket): SocketAttachment | null {
  const attachment = socket.deserializeAttachment();
  if (!attachment || typeof attachment !== "object") return null;
  const token = (attachment as Record<string, unknown>).token;
  return typeof token === "string" ? { token } : null;
}

function parseSeatToken(request: Request): string | null {
  const token = new URL(request.url).searchParams.get("seat");
  return token && /^[a-f0-9]{32}$/.test(token) ? token : null;
}

function isMove(value: unknown): value is GoMove | XiangqiMove {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.x === "number" && typeof candidate.y === "number") return true;
  const from = candidate.from as Record<string, unknown> | undefined;
  const to = candidate.to as Record<string, unknown> | undefined;
  return Boolean(
    from && to &&
    typeof from.x === "number" && typeof from.y === "number" &&
    typeof to.x === "number" && typeof to.y === "number",
  );
}

function parseClientMessage(message: string): RoomClientMessage | null {
  if (message.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    if (value.type === "sync" || value.type === "pass" || value.type === "resign") return { type: value.type };
    if (value.type === "move" && isMove(value.move)) return { type: "move", move: value.move };
    return null;
  } catch {
    return null;
  }
}

export class GameRoom extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/initialize") {
      return this.initialize(request);
    }
    if (request.method === "GET" && url.pathname === "/preview") {
      return this.preview();
    }
    if (request.method === "POST" && url.pathname === "/join") {
      return this.join();
    }
    if (request.method === "GET" && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.connectWebSocket(request);
    }
    return json({ error: { code: "NOT_FOUND", message: "Unknown room operation." } }, 404);
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.sendError(socket, "消息格式无效。");
      return;
    }
    const command = parseClientMessage(message);
    if (!command) {
      this.sendError(socket, "消息格式无效。");
      return;
    }

    const room = await this.loadRoom();
    const attachment = attachmentFor(socket);
    if (!room || !attachment) return;
    const seat = this.seatForToken(room, attachment.token);
    if (!seat) return;

    if (command.type === "sync") {
      this.sendSnapshot(socket, room);
      return;
    }

    if (command.type === "resign") {
      await this.resign(room, seat.side);
      return;
    }
    if (command.type === "pass") {
      await this.pass(room, seat.side, socket);
      return;
    }
    await this.move(room, seat.side, command.move, socket);
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.handleDisconnect(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.handleDisconnect(socket);
  }

  async alarm(): Promise<void> {
    let room = await this.loadRoom();
    if (!room) return;
    const now = Date.now();

    if (room.phase === "waiting" && room.waitingExpiresAt !== null && now >= room.waitingExpiresAt) {
      await this.finish(room, { winner: null, reason: "expired" }, "expired");
      return;
    }

    if (room.phase === "playing" && room.disconnectExpiresAt !== null && now >= room.disconnectExpiresAt) {
      const connectedSides = this.connectedSides(room);
      if (connectedSides.length === 2) {
        await this.clearDisconnect(room);
        return;
      }
      if (connectedSides.length === 0) {
        await this.finish(room, { winner: null, reason: "abandoned" }, "abandoned");
        return;
      }
      await this.finish(room, { winner: connectedSides[0], reason: "disconnect" }, "finished");
      return;
    }

    if (room.phase !== "finished" && room.phase !== "abandoned" && room.phase !== "expired") return;
    if (typeof room.capacityReleaseRetryAt === "number" && now >= room.capacityReleaseRetryAt) {
      room = await this.releaseCapacity(room);
    }
    if (room.postgameExpiresAt !== null && now >= room.postgameExpiresAt) {
      room = await this.releaseCapacity(room);
      if (!room.capacityReleased) return;
      await this.ctx.storage.delete(ROOM_KEY);
      for (const socket of this.ctx.getWebSockets()) socket.close(4001, "Room expired");
    }
  }

  private async initialize(request: Request): Promise<Response> {
    const roomId = request.headers.get("x-game-room-id");
    if (!roomId || !/^[a-f0-9]{32}$/.test(roomId)) {
      return json({ error: { code: "FORBIDDEN", message: "Room initialization is internal only." } }, 403);
    }
    if (await this.loadRoom()) {
      return json({ error: { code: "CONFLICT", message: "The room already exists." } }, 409);
    }

    const body = await request.json().catch(() => null);
    const input = parseCreateRequest(body);
    if (!input) {
      return json({ error: { code: "BAD_REQUEST", message: "Invalid room configuration." } }, 400);
    }

    const configuration: RoomConfiguration = {
      game: input.game,
      goSize: input.game === "go" ? input.goSize ?? null : null,
      hostSide: input.hostSide,
    };
    const host: StoredSeat = { token: randomToken(), side: configuration.hostSide };
    const waitingExpiresAt = Date.now() + WAITING_ROOM_DURATION_MS;
    const room: StoredRoom = {
      roomId,
      capacityReleased: false,
      capacityReleaseRetryAt: null,
      configuration,
      gameState: configuration.game === "go"
        ? createGoState(configuration.goSize ?? 9)
        : createXiangqiState(),
      seats: [host, null],
      phase: "waiting",
      waitingExpiresAt,
      disconnectExpiresAt: null,
      disconnectedSide: null,
      postgameExpiresAt: null,
      outcome: null,
    };
    await this.saveRoom(room);
    await this.ctx.storage.setAlarm(waitingExpiresAt);

    const response: CreateRoomResponse = {
      roomId,
      seat: host,
      snapshot: this.snapshot(room),
    };
    return json(response, 201);
  }

  private async preview(): Promise<Response> {
    const room = await this.loadRoom();
    if (!room) return json({ error: { code: "NOT_FOUND", message: "The room does not exist." } }, 404);
    if (await this.expireWaitingRoomIfDue(room)) {
      return json({ error: { code: "ROOM_EXPIRED", message: "This room has expired." } }, 410);
    }
    if (room.phase !== "waiting" || room.seats[1]) {
      return json({ error: { code: "ROOM_UNAVAILABLE", message: "This room is no longer available to join." } }, 409);
    }
    const preview: RoomPreview = {
      configuration: room.configuration,
      waitingExpiresAt: room.waitingExpiresAt ?? Date.now(),
    };
    return json(preview);
  }

  private async join(): Promise<Response> {
    const room = await this.loadRoom();
    if (!room) return json({ error: { code: "NOT_FOUND", message: "The room does not exist." } }, 404);
    if (await this.expireWaitingRoomIfDue(room)) {
      return json({ error: { code: "ROOM_EXPIRED", message: "This room has expired." } }, 410);
    }
    if (room.phase !== "waiting") {
      return json({ error: { code: "ROOM_UNAVAILABLE", message: "This room is no longer available to join." } }, 409);
    }
    if (room.seats[1]) {
      return json({ error: { code: "ROOM_FULL", message: "Both player seats are already assigned." } }, 409);
    }

    const guest: StoredSeat = { token: randomToken(), side: otherSide(room.configuration) };
    const next: StoredRoom = { ...room, seats: [room.seats[0], guest] };
    await this.saveRoom(next);
    this.broadcast(next);
    const response: JoinRoomResponse = { seat: guest, snapshot: this.snapshot(next) };
    return json(response, 201);
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    const token = parseSeatToken(request);
    if (!token) {
      return json({ error: { code: "UNAUTHORIZED", message: "A valid player seat is required." } }, 401);
    }
    const room = await this.loadRoom();
    if (!room) return json({ error: { code: "NOT_FOUND", message: "The room does not exist." } }, 404);
    if (await this.expireWaitingRoomIfDue(room)) {
      return json({ error: { code: "ROOM_EXPIRED", message: "This room has expired." } }, 410);
    }
    const seat = this.seatForToken(room, token);
    if (!seat) {
      return json({ error: { code: "UNAUTHORIZED", message: "This browser does not hold a player seat." } }, 401);
    }

    for (const existing of this.ctx.getWebSockets()) {
      if (attachmentFor(existing)?.token === token) existing.close(4000, "Replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token } satisfies SocketAttachment);

    const activeRoom = await this.startOrResume(room);
    this.broadcast(activeRoom, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async move(
    room: StoredRoom,
    side: OnlineSide,
    move: GoMove | XiangqiMove,
    socket: WebSocket,
  ): Promise<void> {
    if (!this.canPlay(room, side)) {
      this.sendError(socket, "当前不能落子，请等待双方连接并轮到你行棋。");
      return;
    }

    if (room.configuration.game === "go") {
      if (!isGoMove(move)) {
        this.sendError(socket, "围棋着法格式无效。");
        return;
      }
      const result = playGoMove(room.gameState as GoState, move);
      if (!result.ok) {
        this.sendError(socket, result.error);
        return;
      }
      const next = { ...room, gameState: result.state };
      if (result.state.status === "finished") {
        await this.finish(next, { winner: result.state.score?.winner ?? null, reason: "rule" }, "finished");
      } else {
        await this.saveRoom(next);
        this.broadcast(next);
      }
      return;
    }

    if (!isXiangqiMove(move)) {
      this.sendError(socket, "象棋着法格式无效。");
      return;
    }
    const result = playXiangqiMove(room.gameState as XiangqiState, move);
    if (!result.ok) {
      this.sendError(socket, result.error);
      return;
    }
    const next = { ...room, gameState: result.state };
    if (result.state.status !== "playing") {
      await this.finish(
        next,
        { winner: result.state.winner, reason: "rule" },
        "finished",
      );
    } else {
      await this.saveRoom(next);
      this.broadcast(next);
    }
  }

  private async pass(room: StoredRoom, side: OnlineSide, socket: WebSocket): Promise<void> {
    if (room.configuration.game !== "go") {
      this.sendError(socket, "只有围棋可以停一手。");
      return;
    }
    if (!this.canPlay(room, side)) {
      this.sendError(socket, "当前不能停一手，请等待双方连接并轮到你行棋。");
      return;
    }
    const result = playGoMove(room.gameState as GoState, "pass");
    if (!result.ok) {
      this.sendError(socket, result.error);
      return;
    }
    const next = { ...room, gameState: result.state };
    if (result.state.status === "finished") {
      await this.finish(next, { winner: result.state.score?.winner ?? null, reason: "rule" }, "finished");
    } else {
      await this.saveRoom(next);
      this.broadcast(next);
    }
  }

  private async resign(room: StoredRoom, side: OnlineSide): Promise<void> {
    if (room.phase !== "playing") return;
    await this.finish(room, { winner: otherSeatSide(room, side), reason: "resignation" }, "finished");
  }

  private async handleDisconnect(socket: WebSocket): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) return;
    const room = await this.loadRoom();
    if (!room || room.phase !== "playing") return;
    const seat = this.seatForToken(room, attachment.token);
    if (!seat) return;
    if (this.hasLiveConnection(attachment.token, socket)) return;
    if (room.disconnectExpiresAt !== null && room.disconnectedSide === seat.side) return;

    const disconnectExpiresAt = Date.now() + DISCONNECT_GRACE_MS;
    const next: StoredRoom = {
      ...room,
      disconnectExpiresAt,
      disconnectedSide: seat.side,
    };
    await this.saveRoom(next);
    await this.ctx.storage.setAlarm(disconnectExpiresAt);
    this.broadcast(next, socket);
  }

  private async startOrResume(room: StoredRoom): Promise<StoredRoom> {
    if (room.phase !== "waiting") {
      if (room.phase === "playing" && room.disconnectExpiresAt !== null && this.connectedSides(room).length === 2) {
        return this.clearDisconnect(room);
      }
      return room;
    }
    if (!room.seats[1] || this.connectedSides(room).length !== 2) return room;

    const next: StoredRoom = {
      ...room,
      phase: "playing",
      waitingExpiresAt: null,
    };
    await this.saveRoom(next);
    await this.ctx.storage.deleteAlarm();
    return next;
  }

  private async clearDisconnect(room: StoredRoom): Promise<StoredRoom> {
    const next: StoredRoom = { ...room, disconnectExpiresAt: null, disconnectedSide: null };
    await this.saveRoom(next);
    await this.ctx.storage.deleteAlarm();
    this.broadcast(next);
    return next;
  }

  private async finish(room: StoredRoom, outcome: RoomOutcome, phase: "finished" | "abandoned" | "expired"): Promise<void> {
    const postgameExpiresAt = Date.now() + POSTGAME_DURATION_MS;
    const next: StoredRoom = {
      ...room,
      capacityReleased: !room.roomId,
      capacityReleaseRetryAt: null,
      phase,
      waitingExpiresAt: null,
      disconnectExpiresAt: null,
      disconnectedSide: null,
      postgameExpiresAt,
      outcome,
    };
    await this.saveRoom(next);
    await this.ctx.storage.setAlarm(postgameExpiresAt);
    this.broadcast(await this.releaseCapacity(next));
  }

  private async releaseCapacity(room: StoredRoom): Promise<StoredRoom> {
    if (room.capacityReleased) return room;
    if (!room.roomId) {
      const released: StoredRoom = { ...room, capacityReleased: true, capacityReleaseRetryAt: null };
      await this.saveRoom(released);
      return released;
    }
    try {
      const response = await this.env.ACTIVE_ROOM_REGISTRY.getByName(ACTIVE_ROOM_REGISTRY_NAME).fetch(
        new Request("https://capacity.internal/release", {
          method: "POST",
          headers: { "x-game-room-id": room.roomId },
        }),
      );
      if (!response.ok) throw new Error("Room capacity release failed.");
      const released: StoredRoom = { ...room, capacityReleased: true, capacityReleaseRetryAt: null };
      await this.saveRoom(released);
      return released;
    } catch {
      const capacityReleaseRetryAt = Date.now() + CAPACITY_RELEASE_RETRY_MS;
      const pending: StoredRoom = { ...room, capacityReleaseRetryAt };
      await this.saveRoom(pending);
      await this.ctx.storage.setAlarm(Math.min(room.postgameExpiresAt ?? capacityReleaseRetryAt, capacityReleaseRetryAt));
      return pending;
    }
  }

  private async expireWaitingRoomIfDue(room: StoredRoom): Promise<boolean> {
    if (room.phase !== "waiting" || room.waitingExpiresAt === null || Date.now() < room.waitingExpiresAt) {
      return false;
    }
    await this.finish(room, { winner: null, reason: "expired" }, "expired");
    return true;
  }

  private canPlay(room: StoredRoom, side: OnlineSide): boolean {
    if (room.phase !== "playing" || this.connectedSides(room).length !== 2) return false;
    return room.gameState.turn === side;
  }

  private connectedSides(room: StoredRoom): OnlineSide[] {
    const connected = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment) connected.add(attachment.token);
    }
    return room.seats.flatMap((seat) => seat && connected.has(seat.token) ? [seat.side] : []);
  }

  private hasLiveConnection(token: string, ignored: WebSocket): boolean {
    return this.ctx.getWebSockets().some((socket) => socket !== ignored && attachmentFor(socket)?.token === token);
  }

  private seatForToken(room: StoredRoom, token: string): StoredSeat | null {
    return room.seats.find((seat) => seat?.token === token) ?? null;
  }

  private snapshot(room: StoredRoom): RoomSnapshot {
    const connectedSides = new Set(this.connectedSides(room));
    const deadlineAt = room.phase === "waiting"
      ? room.waitingExpiresAt
      : room.phase === "playing"
        ? room.disconnectExpiresAt
        : room.postgameExpiresAt;
    const host = room.seats[0];
    const guest = room.seats[1];
    return {
      configuration: room.configuration,
      phase: room.phase,
      gameState: room.gameState,
      seats: [
        { side: host.side, connected: connectedSides.has(host.side) },
        guest ? { side: guest.side, connected: connectedSides.has(guest.side) } : null,
      ],
      deadlineAt,
      disconnectedSide: room.disconnectedSide,
      outcome: room.outcome,
    };
  }

  private broadcast(room: StoredRoom, excluded?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== excluded) this.sendSnapshot(socket, room);
    }
  }

  private sendSnapshot(socket: WebSocket, room: StoredRoom): void {
    this.send(socket, { type: "snapshot", snapshot: this.snapshot(room) });
  }

  private sendError(socket: WebSocket, message: string): void {
    this.send(socket, { type: "error", message });
  }

  private send(socket: WebSocket, message: RoomServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // A close may race a broadcast; the lifecycle handler owns reconnection state.
    }
  }

  private async loadRoom(): Promise<StoredRoom | null> {
    return (await this.ctx.storage.get<StoredRoom>(ROOM_KEY)) ?? null;
  }

  private async saveRoom(room: StoredRoom): Promise<void> {
    await this.ctx.storage.put(ROOM_KEY, room);
  }
}

function isGoMove(move: GoMove | XiangqiMove): move is GoMove {
  return "x" in move && "y" in move;
}

function isXiangqiMove(move: GoMove | XiangqiMove): move is XiangqiMove {
  return "from" in move && "to" in move;
}

function otherSeatSide(room: StoredRoom, side: OnlineSide): OnlineSide {
  const other = room.seats.find((seat) => seat?.side !== side);
  return other?.side ?? side;
}
