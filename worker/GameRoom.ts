import { DurableObject } from "cloudflare:workers";
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
const POLL_PRESENCE_WINDOW_MS = 8_000;

interface StoredSeat extends RoomSeatSession {
  readonly lastSeenAt: number | null;
}

interface StoredRoom {
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

interface CommandRequest {
  readonly token: string;
  readonly command: RoomClientMessage;
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

function parseClientCommand(value: unknown): RoomClientMessage | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === "sync" || candidate.type === "pass" || candidate.type === "resign") {
    return { type: candidate.type };
  }
  return candidate.type === "move" && isMove(candidate.move) ? { type: "move", move: candidate.move } : null;
}

function parseClientMessage(message: string): RoomClientMessage | null {
  if (message.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    return parseClientCommand(JSON.parse(message));
  } catch {
    return null;
  }
}

function parseCommandRequest(message: string): CommandRequest | null {
  if (message.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(message) as Record<string, unknown>;
    const token = value.token;
    const command = parseClientCommand(value.command);
    return typeof token === "string" && /^[a-f0-9]{32}$/.test(token) && command ? { token, command } : null;
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
    if (request.method === "GET" && url.pathname === "/state") {
      return this.state(request);
    }
    if (request.method === "POST" && url.pathname === "/command") {
      return this.command(request);
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

    const error = command.type === "resign"
      ? await this.resign(room, seat.side)
      : command.type === "pass"
        ? await this.pass(room, seat.side)
        : await this.move(room, seat.side, command.move);
    if (error) this.sendError(socket, error);
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    console.info(JSON.stringify({
      event: "room_socket_closed",
      room: this.ctx.id.toString(),
      code,
      reason,
      wasClean,
    }));
    await this.handleDisconnect(socket);
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.warn(JSON.stringify({
      event: "room_socket_error",
      room: this.ctx.id.toString(),
      message: error instanceof Error ? error.message : String(error),
    }));
    await this.handleDisconnect(socket);
  }

  async alarm(): Promise<void> {
    const room = await this.loadRoom();
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

    if (room.phase === "playing" && room.disconnectExpiresAt === null) {
      const connectedSides = this.connectedSides(room);
      if (connectedSides.length < 2) {
        await this.startDisconnectGrace(
          room,
          connectedSides.length === 1 ? otherSeatSide(room, connectedSides[0]) : room.seats[0].side,
        );
      } else {
        await this.schedulePresenceAlarm(room);
      }
      return;
    }

    if (
      (room.phase === "finished" || room.phase === "abandoned" || room.phase === "expired") &&
      room.postgameExpiresAt !== null && now >= room.postgameExpiresAt
    ) {
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
    const host: StoredSeat = { token: randomToken(), side: configuration.hostSide, lastSeenAt: null };
    const waitingExpiresAt = Date.now() + WAITING_ROOM_DURATION_MS;
    const room: StoredRoom = {
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

  private async state(request: Request): Promise<Response> {
    const token = parseSeatToken(request);
    if (!token) return json({ error: { code: "UNAUTHORIZED", message: "A valid player seat is required." } }, 401);
    const room = await this.loadRoom();
    if (!room) return json({ error: { code: "NOT_FOUND", message: "The room does not exist." } }, 404);
    if (await this.expireWaitingRoomIfDue(room)) {
      return json({ error: { code: "ROOM_EXPIRED", message: "This room has expired." } }, 410);
    }
    if (!this.seatForToken(room, token)) {
      return json({ error: { code: "UNAUTHORIZED", message: "This browser does not hold a player seat." } }, 401);
    }
    return json(this.snapshot(await this.touchSeat(room, token)));
  }

  private async command(request: Request): Promise<Response> {
    const input = parseCommandRequest(await request.text());
    if (!input) return json({ error: { code: "BAD_REQUEST", message: "Invalid room command." } }, 400);
    const room = await this.loadRoom();
    if (!room) return json({ error: { code: "NOT_FOUND", message: "The room does not exist." } }, 404);
    if (await this.expireWaitingRoomIfDue(room)) {
      return json({ error: { code: "ROOM_EXPIRED", message: "This room has expired." } }, 410);
    }
    const seat = this.seatForToken(room, input.token);
    if (!seat) {
      return json({ error: { code: "UNAUTHORIZED", message: "This browser does not hold a player seat." } }, 401);
    }

    const activeRoom = await this.touchSeat(room, input.token);
    const error = input.command.type === "sync"
      ? null
      : input.command.type === "resign"
        ? await this.resign(activeRoom, seat.side)
        : input.command.type === "pass"
          ? await this.pass(activeRoom, seat.side)
          : await this.move(activeRoom, seat.side, input.command.move);
    if (error) return json({ error: { code: "INVALID_COMMAND", message: error } }, 409);
    return json(this.snapshot((await this.loadRoom()) ?? activeRoom));
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

    const guest: StoredSeat = { token: randomToken(), side: otherSide(room.configuration), lastSeenAt: null };
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
    console.info(JSON.stringify({
      event: "room_socket_connected",
      room: this.ctx.id.toString(),
      side: seat.side,
      phase: activeRoom.phase,
      connectedSides: this.connectedSides(activeRoom),
    }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private async move(
    room: StoredRoom,
    side: OnlineSide,
    move: GoMove | XiangqiMove,
  ): Promise<string | null> {
    if (!this.canPlay(room, side)) return "当前不能落子，请等待双方连接并轮到你行棋。";

    if (room.configuration.game === "go") {
      if (!isGoMove(move)) return "围棋着法格式无效。";
      const result = playGoMove(room.gameState as GoState, move);
      if (!result.ok) return result.error;
      const next = { ...room, gameState: result.state };
      if (result.state.status === "finished") {
        await this.finish(next, { winner: result.state.score?.winner ?? null, reason: "rule" }, "finished");
      } else {
        await this.saveRoom(next);
        this.broadcast(next);
      }
      return null;
    }

    if (!isXiangqiMove(move)) return "象棋着法格式无效。";
    const result = playXiangqiMove(room.gameState as XiangqiState, move);
    if (!result.ok) return result.error;
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
    return null;
  }

  private async pass(room: StoredRoom, side: OnlineSide): Promise<string | null> {
    if (room.configuration.game !== "go") return "只有围棋可以停一手。";
    if (!this.canPlay(room, side)) return "当前不能停一手，请等待双方连接并轮到你行棋。";
    const result = playGoMove(room.gameState as GoState, "pass");
    if (!result.ok) return result.error;
    const next = { ...room, gameState: result.state };
    if (result.state.status === "finished") {
      await this.finish(next, { winner: result.state.score?.winner ?? null, reason: "rule" }, "finished");
    } else {
      await this.saveRoom(next);
      this.broadcast(next);
    }
    return null;
  }

  private async resign(room: StoredRoom, side: OnlineSide): Promise<string | null> {
    if (room.phase !== "playing") return "当前不能认输。";
    await this.finish(room, { winner: otherSeatSide(room, side), reason: "resignation" }, "finished");
    return null;
  }

  private async handleDisconnect(socket: WebSocket): Promise<void> {
    const attachment = attachmentFor(socket);
    if (!attachment) {
      console.warn(JSON.stringify({ event: "room_socket_attachment_missing", room: this.ctx.id.toString() }));
      return;
    }
    const room = await this.loadRoom();
    if (!room || room.phase !== "playing") return;
    const seat = this.seatForToken(room, attachment.token);
    if (!seat) return;
    if (this.hasLiveConnection(attachment.token, socket)) {
      console.info(JSON.stringify({
        event: "room_socket_replaced",
        room: this.ctx.id.toString(),
        side: seat.side,
      }));
      return;
    }
    if (room.disconnectExpiresAt !== null && room.disconnectedSide === seat.side) return;
    await this.startDisconnectGrace(room, seat.side, socket);
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
    await this.schedulePresenceAlarm(next);
    return next;
  }

  private async clearDisconnect(room: StoredRoom): Promise<StoredRoom> {
    const next: StoredRoom = { ...room, disconnectExpiresAt: null, disconnectedSide: null };
    await this.saveRoom(next);
    await this.ctx.storage.deleteAlarm();
    await this.schedulePresenceAlarm(next);
    this.broadcast(next);
    return next;
  }

  private async finish(room: StoredRoom, outcome: RoomOutcome, phase: "finished" | "abandoned" | "expired"): Promise<void> {
    const postgameExpiresAt = Date.now() + POSTGAME_DURATION_MS;
    const next: StoredRoom = {
      ...room,
      phase,
      waitingExpiresAt: null,
      disconnectExpiresAt: null,
      disconnectedSide: null,
      postgameExpiresAt,
      outcome,
    };
    await this.saveRoom(next);
    await this.ctx.storage.setAlarm(postgameExpiresAt);
    this.broadcast(next);
  }

  private async expireWaitingRoomIfDue(room: StoredRoom): Promise<boolean> {
    if (room.phase !== "waiting" || room.waitingExpiresAt === null || Date.now() < room.waitingExpiresAt) {
      return false;
    }
    await this.finish(room, { winner: null, reason: "expired" }, "expired");
    return true;
  }

  private async touchSeat(room: StoredRoom, token: string): Promise<StoredRoom> {
    const seenAt = Date.now();
    const host = room.seats[0].token === token ? { ...room.seats[0], lastSeenAt: seenAt } : room.seats[0];
    const guest = room.seats[1]?.token === token ? { ...room.seats[1], lastSeenAt: seenAt } : room.seats[1];
    const touched: StoredRoom = { ...room, seats: [host, guest] };
    await this.saveRoom(touched);
    const activeRoom = await this.startOrResume(touched);
    await this.schedulePresenceAlarm(activeRoom);
    return activeRoom;
  }

  private async startDisconnectGrace(room: StoredRoom, side: OnlineSide, excluded?: WebSocket): Promise<void> {
    if (room.disconnectExpiresAt !== null) return;
    const disconnectExpiresAt = Date.now() + DISCONNECT_GRACE_MS;
    const next: StoredRoom = {
      ...room,
      disconnectExpiresAt,
      disconnectedSide: side,
    };
    await this.saveRoom(next);
    await this.ctx.storage.setAlarm(disconnectExpiresAt);
    console.info(JSON.stringify({
      event: "room_disconnect_grace_started",
      room: this.ctx.id.toString(),
      side,
      connectedSides: this.connectedSides(next),
      disconnectExpiresAt,
    }));
    this.broadcast(next, excluded);
  }

  private async schedulePresenceAlarm(room: StoredRoom): Promise<void> {
    if (room.phase !== "playing" || room.disconnectExpiresAt !== null) return;
    const liveTokens = this.liveConnectionTokens();
    const deadlines = room.seats.flatMap((seat) => {
      if (!seat || liveTokens.has(seat.token) || seat.lastSeenAt === null) return [];
      return [seat.lastSeenAt + POLL_PRESENCE_WINDOW_MS];
    });
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }

  private canPlay(room: StoredRoom, side: OnlineSide): boolean {
    if (room.phase !== "playing" || this.connectedSides(room).length !== 2) return false;
    return room.gameState.turn === side;
  }

  private connectedSides(room: StoredRoom): OnlineSide[] {
    const connected = this.liveConnectionTokens();
    const activeSince = Date.now() - POLL_PRESENCE_WINDOW_MS;
    return room.seats.flatMap((seat) => {
      if (!seat) return [];
      const isPolling = seat.lastSeenAt !== null && seat.lastSeenAt >= activeSince;
      return connected.has(seat.token) || isPolling ? [seat.side] : [];
    });
  }

  private liveConnectionTokens(): Set<string> {
    const connected = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = attachmentFor(socket);
      if (attachment) connected.add(attachment.token);
    }
    return connected;
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
