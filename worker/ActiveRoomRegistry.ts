import { DurableObject } from "cloudflare:workers";

export const ACTIVE_ROOM_REGISTRY_NAME = "active-room-capacity";

const ACTIVE_ROOMS_KEY = "active-room-ids";
const ROOM_ID_PATTERN = /^[a-f0-9]{32}$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function roomId(request: Request): string | null {
  const value = request.headers.get("x-game-room-id");
  return value && ROOM_ID_PATTERN.test(value) ? value : null;
}

function limit(request: Request): number | null {
  const value = Number(request.headers.get("x-max-active-rooms"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export class ActiveRoomRegistry extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/reserve") return this.reserve(request);
    if (request.method === "POST" && url.pathname === "/release") return this.release(request);
    return json({ error: { code: "NOT_FOUND", message: "Unknown capacity operation." } }, 404);
  }

  private async reserve(request: Request): Promise<Response> {
    const id = roomId(request);
    const maxActiveRooms = limit(request);
    if (!id || maxActiveRooms === null) {
      return json({ error: { code: "BAD_REQUEST", message: "Invalid room capacity reservation." } }, 400);
    }

    const roomIds = (await this.ctx.storage.get<string[]>(ACTIVE_ROOMS_KEY)) ?? [];
    if (roomIds.includes(id)) return json({ activeRooms: roomIds.length });
    if (roomIds.length >= maxActiveRooms) {
      return json({
        error: {
          code: "ACTIVE_ROOM_LIMIT_REACHED",
          message: "当前在线对弈房间数量已达上限，请稍后重试。",
        },
      }, 429);
    }

    const next = [...roomIds, id];
    await this.ctx.storage.put(ACTIVE_ROOMS_KEY, next);
    return json({ activeRooms: next.length }, 201);
  }

  private async release(request: Request): Promise<Response> {
    const id = roomId(request);
    if (!id) return json({ error: { code: "BAD_REQUEST", message: "Invalid room capacity release." } }, 400);

    const roomIds = (await this.ctx.storage.get<string[]>(ACTIVE_ROOMS_KEY)) ?? [];
    const next = roomIds.filter((roomId) => roomId !== id);
    if (next.length !== roomIds.length) await this.ctx.storage.put(ACTIVE_ROOMS_KEY, next);
    return json({ activeRooms: next.length });
  }
}
