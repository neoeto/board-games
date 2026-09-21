import { useEffect, useRef, useState } from "react";
import { GoBoard } from "./GoBoard";
import { XiangqiBoard } from "./XiangqiBoard";
import type { GoColor, GoMove, GoState } from "../games/go";
import type { XiangqiMove, XiangqiSide, XiangqiState } from "../games/xiangqi";
import {
  type CreateRoomResponse,
  type JoinRoomResponse,
  type OnlineGameId,
  type OnlineSide,
  type RoomConfiguration,
  type RoomPreview,
  type RoomSeatSession,
  type RoomServerMessage,
  type RoomSnapshot,
} from "../online/protocol";

type OnlineScreen = "lobby" | "join" | "room";
type ConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

type GoRoomSnapshot = RoomSnapshot & {
  readonly configuration: RoomConfiguration & { readonly game: "go" };
  readonly gameState: GoState;
};

type XiangqiRoomSnapshot = RoomSnapshot & {
  readonly configuration: RoomConfiguration & { readonly game: "xiangqi" };
  readonly gameState: XiangqiState;
};

interface OnlinePlayProps {
  readonly game: OnlineGameId;
}

const ROOM_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_RECONNECT_ATTEMPTS = 120;

function roomStorageKey(roomId: string): string {
  return `just-go.online.room.${roomId}`;
}

function roomIdFromLocation(): string | null {
  const roomId = new URL(window.location.href).searchParams.get("room");
  return roomId && ROOM_ID_PATTERN.test(roomId) ? roomId : null;
}

function readSeat(roomId: string): RoomSeatSession | null {
  try {
    const raw = window.localStorage.getItem(roomStorageKey(roomId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Record<string, unknown>;
    const token = value.token;
    const side = value.side;
    return typeof token === "string" && /^[a-f0-9]{32}$/.test(token) && isOnlineSide(side)
      ? { token, side }
      : null;
  } catch {
    return null;
  }
}

function persistSeat(roomId: string, seat: RoomSeatSession): void {
  window.localStorage.setItem(roomStorageKey(roomId), JSON.stringify(seat));
}

function isOnlineSide(value: unknown): value is OnlineSide {
  return value === "black" || value === "white" || value === "red";
}

function isRoomConfiguration(value: unknown): value is RoomConfiguration {
  if (!value || typeof value !== "object") return false;
  const configuration = value as Record<string, unknown>;
  if (configuration.game === "go") {
    return (configuration.goSize === 9 || configuration.goSize === 13 || configuration.goSize === 19) &&
      (configuration.hostSide === "black" || configuration.hostSide === "white");
  }
  return configuration.game === "xiangqi" && configuration.goSize === null &&
    (configuration.hostSide === "red" || configuration.hostSide === "black");
}

function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return isRoomConfiguration(snapshot.configuration) &&
    (snapshot.phase === "waiting" || snapshot.phase === "playing" || snapshot.phase === "finished" || snapshot.phase === "abandoned" || snapshot.phase === "expired") &&
    Boolean(snapshot.gameState) && Array.isArray(snapshot.seats) && snapshot.seats.length === 2;
}

function isSeatResponse(value: unknown): value is { readonly seat: RoomSeatSession; readonly snapshot: RoomSnapshot } {
  if (!value || typeof value !== "object") return false;
  const response = value as Record<string, unknown>;
  const seat = response.seat as Record<string, unknown> | undefined;
  return Boolean(seat && typeof seat.token === "string" && /^[a-f0-9]{32}$/.test(seat.token) &&
    isOnlineSide(seat.side) && isRoomSnapshot(response.snapshot));
}

function isCreateResponse(value: unknown): value is CreateRoomResponse {
  return isSeatResponse(value) && typeof (value as Record<string, unknown>).roomId === "string" &&
    ROOM_ID_PATTERN.test((value as Record<string, unknown>).roomId as string);
}

function isRoomPreview(value: unknown): value is RoomPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Record<string, unknown>;
  return isRoomConfiguration(preview.configuration) && typeof preview.waitingExpiresAt === "number";
}

function isRoomMessage(value: unknown): value is RoomServerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === "error" && typeof message.message === "string" ||
    message.type === "snapshot" && isRoomSnapshot(message.snapshot);
}

function errorText(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return fallback;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : fallback;
}

function websocketUrl(roomId: string, token: string): string {
  const url = new URL(`/api/rooms/${roomId}`, window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("seat", token);
  return url.href;
}

function gameName(game: OnlineGameId): string {
  return game === "go" ? "围棋" : "中国象棋";
}

function sideName(game: OnlineGameId, side: OnlineSide): string {
  if (game === "go") return side === "black" ? "黑方" : "白方";
  return side === "red" ? "红方" : "黑方";
}

function otherSide(game: OnlineGameId, side: OnlineSide): OnlineSide {
  if (game === "go") return side === "black" ? "white" : "black";
  return side === "red" ? "black" : "red";
}

function formatRemaining(deadlineAt: number | null, now: number): string | null {
  if (deadlineAt === null) return null;
  const seconds = Math.max(0, Math.ceil((deadlineAt - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function isGoRoom(snapshot: RoomSnapshot | null): snapshot is GoRoomSnapshot {
  return snapshot?.configuration.game === "go";
}

function isXiangqiRoom(snapshot: RoomSnapshot | null): snapshot is XiangqiRoomSnapshot {
  return snapshot?.configuration.game === "xiangqi";
}

function roomStatus(snapshot: RoomSnapshot, side: OnlineSide, now: number): string {
  const game = snapshot.configuration.game;
  const countdown = formatRemaining(snapshot.deadlineAt, now);
  if (snapshot.phase === "waiting") {
    if (!snapshot.seats[1]) return `等待对手确认加入，房间将在 ${countdown ?? "稍后"} 过期。`;
    return `对手已加入，等待双方同时在线开局。房间将在 ${countdown ?? "稍后"} 过期。`;
  }
  if (snapshot.phase === "playing") {
    if (snapshot.disconnectedSide) {
      return `${sideName(game, snapshot.disconnectedSide)}断线，${countdown ?? "2:00"} 内重连即可续局。`;
    }
    return snapshot.gameState.turn === side ? "轮到你行棋。" : `等待${sideName(game, snapshot.gameState.turn)}行棋。`;
  }
  if (snapshot.outcome?.reason === "abandoned") return "双方断线，棋局作废。";
  if (snapshot.outcome?.reason === "expired") return "无人完成开局，房间已过期。";
  if (snapshot.outcome?.winner) {
    const reason = snapshot.outcome.reason === "resignation" ? "对手认输" :
      snapshot.outcome.reason === "disconnect" ? "对手断线超时" : "按规则终局";
    return `${sideName(game, snapshot.outcome.winner)}胜 · ${reason}。`;
  }
  return "棋局结束。";
}

export function OnlinePlay({ game }: OnlinePlayProps) {
  const initialRoomId = roomIdFromLocation();
  const initialSeat = initialRoomId ? readSeat(initialRoomId) : null;
  const [screen, setScreen] = useState<OnlineScreen>(initialRoomId ? initialSeat ? "room" : "join" : "lobby");
  const [roomId, setRoomId] = useState<string | null>(initialRoomId);
  const [seat, setSeat] = useState<RoomSeatSession | null>(initialSeat);
  const [goSize, setGoSize] = useState<9 | 13 | 19>(9);
  const [hostSide, setHostSide] = useState<OnlineSide>("black");
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    setHostSide(game === "go" ? "black" : "red");
  }, [game]);

  useEffect(() => {
    if (screen !== "join" || !roomId) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    void fetch(`/api/rooms/${roomId}`)
      .then(async (response) => {
        const body: unknown = await response.json().catch(() => null);
        if (!response.ok) throw new Error(errorText(body, "无法读取邀请房间。"));
        if (!isRoomPreview(body)) throw new Error("服务器返回了无效的房间信息。");
        if (!cancelled) setPreview(body);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取邀请房间。");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [roomId, screen]);

  useEffect(() => {
    if (!snapshot?.deadlineAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot?.deadlineAt]);

  useEffect(() => {
    if (screen !== "room" || !roomId || !seat) return;
    let disposed = false;
    let reconnectTimer: number | undefined;
    let attempt = 0;
    let socket: WebSocket | null = null;
    let opened = false;


    const connect = () => {
      if (disposed) return;
      opened = false;
      setConnection(attempt === 0 ? "connecting" : "reconnecting");
      socket = new WebSocket(websocketUrl(roomId, seat.token));
      socketRef.current = socket;
      socket.onopen = () => {
        opened = true;

        attempt = 0;
        console.info("[online-room]", { event: "socket_open", roomId, side: seat.side });
        socket?.send(JSON.stringify({ type: "sync" }));
        setConnection("connected");
      };
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (!isRoomMessage(message)) return;
          if (message.type === "snapshot") {
            console.info("[online-room]", {
              event: "snapshot",
              roomId,
              phase: message.snapshot.phase,
              seats: message.snapshot.seats,
              disconnectedSide: message.snapshot.disconnectedSide,
            });
            setSnapshot(message.snapshot);
            setError(null);
          } else {
            setError(message.message);
          }
        } catch {
          setError("收到无效的房间同步消息。");
        }
      };
      socket.onerror = () => {
        console.warn("[online-room]", { event: "socket_error", roomId, side: seat.side });
      };
      socket.onclose = (event) => {
        if (disposed) return;
        console.warn("[online-room]", {
          event: "socket_close",
          roomId,
          side: seat.side,
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        if (!opened) {
          setError("实时 WebSocket 未能建立。当前网络代理必须允许 wss://board-games.marching-tech.com:443 的 CONNECT/Upgrade；请将该域名加入代理绕过或白名单后重试。");
        }
        attempt += 1;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          setConnection("closed");
          setError("两分钟内未能恢复房间连接。请确认仍使用原浏览器资料后重试。");
          return;
        }
        setConnection("reconnecting");
        reconnectTimer = window.setTimeout(connect, 1_000);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socketRef.current = null;
      socket?.close(1000, "Leaving room");
    };
  }, [roomId, screen, seat]);

  const activeGame = snapshot?.configuration.game ?? game;
  const ownSide = seat?.side ?? hostSide;
  const canPlay = connection === "connected" && snapshot?.phase === "playing" &&
    snapshot.gameState.turn === ownSide && snapshot.disconnectedSide === null;
  const inviteUrl = roomId ? new URL(`?room=${roomId}`, window.location.href).href : null;

  async function createRoom(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          game,
          ...(game === "go" ? { goSize } : {}),
          hostSide,
        }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(body, "创建房间失败。"));
      if (!isCreateResponse(body)) throw new Error("服务器返回了无效的房间信息。");
      persistSeat(body.roomId, body.seat);
      const location = new URL(window.location.href);
      location.searchParams.set("room", body.roomId);
      window.history.pushState({}, "", location);
      setRoomId(body.roomId);
      setSeat(body.seat);
      setSnapshot(body.snapshot);
      console.info("[online-room]", { event: "room_created", roomId: body.roomId, side: body.seat.side });
      setScreen("room");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "创建房间失败。");
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(): Promise<void> {
    if (!roomId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/rooms/${roomId}`, { method: "POST" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(errorText(body, "加入房间失败。"));
      if (!isSeatResponse(body)) throw new Error("服务器返回了无效的入场信息。");
      const joined = body as JoinRoomResponse;
      persistSeat(roomId, joined.seat);
      setSeat(joined.seat);
      setSnapshot(joined.snapshot);
      console.info("[online-room]", { event: "room_joined", roomId, side: joined.seat.side });
      setScreen("room");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加入房间失败。");
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite(): Promise<void> {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setError(null);
    } catch {
      setError("无法自动复制链接，请手动复制下方地址。");
    }
  }

  function leaveRoom(): void {
    const location = new URL(window.location.href);
    location.searchParams.delete("room");
    window.history.replaceState({}, "", location);
    setRoomId(null);
    setSeat(null);
    setPreview(null);
    setSnapshot(null);
    setConnection("idle");
    setError(null);
    setScreen("lobby");
  }

  function send(command: { readonly type: "move"; readonly move: GoMove | XiangqiMove } | { readonly type: "pass" } | { readonly type: "resign" }): void {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setError("连接尚未就绪，请等待重连完成。");
      return;
    }
    socketRef.current.send(JSON.stringify(command));
  }

  function playGoMove(move: GoMove): void {
    send({ type: "move", move });
  }

  function playXiangqiMove(move: XiangqiMove): boolean {
    send({ type: "move", move });
    return true;
  }

  if (screen === "lobby") {
    const sideOptions: readonly OnlineSide[] = game === "go" ? ["black", "white"] : ["red", "black"];
    return (
      <section className="online-lobby" aria-label="在线对弈">
        <div className="online-lobby-copy">
          <p className="kicker">在线对弈</p>
          <h2>创建一张棋桌</h2>
          <p>房间仅限两名玩家。创建后分享完整邀请链接；双方同时在线后自动开局。</p>
        </div>
        <div className="online-form">
          <div className="field-row">
            <span>棋种</span>
            <strong>{gameName(game)}</strong>
          </div>
          {game === "go" ? (
            <div className="field-row">
              <label htmlFor="online-board-size">棋盘路数</label>
              <select id="online-board-size" disabled={busy} value={goSize} onChange={(event) => setGoSize(Number(event.target.value) as 9 | 13 | 19)}>
                <option value={9}>9 路</option>
                <option value={13}>13 路</option>
                <option value={19}>19 路</option>
              </select>
            </div>
          ) : null}
          <div className="field-row">
            <label htmlFor="online-side">我执</label>
            <select id="online-side" disabled={busy} value={hostSide} onChange={(event) => setHostSide(event.target.value as OnlineSide)}>
              {sideOptions.map((side) => <option key={side} value={side}>{sideName(game, side)}</option>)}
            </select>
          </div>
          <button className="primary-action online-create" disabled={busy} onClick={() => void createRoom()} type="button">
            {busy ? "正在创建…" : "创建并获取邀请链接"}
          </button>
          {error ? <p className="online-error" role="alert">{error}</p> : null}
        </div>
      </section>
    );
  }

  if (screen === "join") {
    const countdown = formatRemaining(preview?.waitingExpiresAt ?? null, now);
    return (
      <section className="online-lobby online-join" aria-label="加入在线房间">
        <div className="online-lobby-copy">
          <p className="kicker">受邀对局</p>
          <h2>{preview ? gameName(preview.configuration.game) : "读取房间中"}</h2>
          {preview ? (
            <p>{preview.configuration.game === "go" ? `${preview.configuration.goSize} 路 · 贴目 7.5` : "标准棋盘 · 简化竞赛规则"}。创建者执{sideName(preview.configuration.game, preview.configuration.hostSide)}，你将执{sideName(preview.configuration.game, otherSide(preview.configuration.game, preview.configuration.hostSide))}。</p>
          ) : <p>正在核对这张邀请棋桌的规则。</p>}
        </div>
        <div className="online-form">
          <p>确认后占用第二个座位；房间剩余 {countdown ?? "—"}。</p>
          <button className="primary-action online-create" disabled={busy || !preview} onClick={() => void joinRoom()} type="button">
            {busy ? "正在加入…" : "确认加入对局"}
          </button>
          <button className="secondary-action online-secondary" onClick={leaveRoom} type="button">返回在线大厅</button>
          {error ? <p className="online-error" role="alert">{error}</p> : null}
        </div>
      </section>
    );
  }

  if (!snapshot || !seat) {
    return <section className="online-lobby"><p role="status">正在连接在线棋桌…</p></section>;
  }

  const goRoom = isGoRoom(snapshot) ? snapshot : null;
  const xiangqiRoom = isXiangqiRoom(snapshot) ? snapshot : null;
  const terminal = snapshot.phase === "finished" || snapshot.phase === "abandoned" || snapshot.phase === "expired";
  const goScore = goRoom?.gameState.status === "finished" ? goRoom.gameState.score : null;

  return (
    <section className="play-room online-room" aria-label={`${gameName(activeGame)}在线对局`}>
      <aside className="control-rail">
        <div className="control-heading">
          <p className="kicker">在线房间</p>
          <h2>你执{sideName(activeGame, ownSide)}</h2>
          <p>{snapshot.configuration.game === "go" ? `${snapshot.configuration.goSize} 路 · 固定贴目 7.5` : "按你的执子方翻转棋盘"}</p>
        </div>

        <div className="online-invite">
          <label htmlFor="invite-url">邀请链接</label>
          <input id="invite-url" readOnly value={inviteUrl ?? ""} />
          <button className="secondary-action" onClick={() => void copyInvite()} type="button">复制链接</button>
        </div>

        <dl className="online-seats">
          {snapshot.seats.map((roomSeat, index) => roomSeat ? (
            <div key={roomSeat.side}>
              <dt>{roomSeat.side === ownSide ? "你" : "对手"} · {sideName(activeGame, roomSeat.side)}</dt>
              <dd>{roomSeat.connected ? "在线" : "离线"}</dd>
            </div>
          ) : <div key={`empty-${index}`}><dt>对手座位</dt><dd>等待加入</dd></div>)}
        </dl>

        <div className="status-block" aria-live="polite">
          <p className="status-label">{connection === "connected" ? "房间已连接" : connection === "reconnecting" ? "正在重连" : "正在连接"}</p>
          <strong>{terminal ? "本局已结束" : snapshot.phase === "waiting" ? "等待开局" : `${sideName(activeGame, snapshot.gameState.turn)}行棋`}</strong>
          <p>{roomStatus(snapshot, ownSide, now)}</p>
          {error ? <p className="error-message" role="alert">{error}</p> : null}
        </div>

        <div className="action-row online-actions">
          {activeGame === "go" ? (
            <button className="primary-action" disabled={!canPlay} onClick={() => send({ type: "pass" })} type="button">停一手</button>
          ) : null}
          <button className="secondary-action" disabled={terminal || connection !== "connected"} onClick={() => send({ type: "resign" })} type="button">认输</button>
        </div>
        <button className="online-leave" onClick={leaveRoom} type="button">离开房间</button>
      </aside>

      <div className="board-panel">
        <div className="board-title">
          <div><span>{activeGame === "go" ? `${goRoom?.gameState.size ?? ""} 路棋盘` : "九路十线"}</span><strong>{gameName(activeGame)}</strong></div>
          <p>{terminal ? "终局" : canPlay ? "轮到你" : "等待对手"}</p>
        </div>
        {goRoom ? <GoBoard disabled={!canPlay} onMove={playGoMove} state={goRoom.gameState} /> : null}
        {xiangqiRoom ? (
          <XiangqiBoard
            disabled={!canPlay}
            key={`${xiangqiRoom.gameState.moveNumber}-${ownSide}`}
            onMessage={(message) => setError(message)}
            onMove={playXiangqiMove}
            playerSide={ownSide as XiangqiSide}
            state={xiangqiRoom.gameState}
          />
        ) : null}
        {goScore ? (
          <div className="score-sheet" aria-label="终局计分">
            <div><span>黑方</span><strong>{goScore.black}</strong><small>活子 {goScore.stones.black} · 地 {goScore.territory.black}</small></div>
            <div><span>白方</span><strong>{goScore.white}</strong><small>活子 {goScore.stones.white} · 地 {goScore.territory.white} · 贴 7.5</small></div>
          </div>
        ) : null}
        <p className="rules-note">联机房间由服务器裁决每一步。无悔棋、和棋请求或观战；认输立即结束。</p>
      </div>
    </section>
  );
}
