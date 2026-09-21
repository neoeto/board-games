export { GameRoom } from "./GameRoom";

const ISOLATION_HEADERS = Object.freeze({
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "cross-origin-isolated=(self)",
});

const ERROR_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

const ROOM_PATH = /^\/api\/rooms\/([a-f0-9]{32})$/;

function withIsolationHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isHtmlOrWorkerResponse(response: Response): boolean {
  if (response.status < 200 || response.status >= 300) return false;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.startsWith("text/html") ||
    contentType.startsWith("application/javascript") ||
    contentType.startsWith("text/javascript") ||
    contentType.startsWith("application/wasm");
}

function errorResponse(
  request: Request,
  status: 400 | 404 | 405 | 426 | 500,
  code: "BAD_REQUEST" | "METHOD_NOT_ALLOWED" | "NOT_FOUND" | "UPGRADE_REQUIRED" | "INTERNAL_ERROR",
  message: string,
): Response {
  const body = request.method === "HEAD" ? null : JSON.stringify({ error: { code, message } });
  return withIsolationHeaders(new Response(body, { status, headers: ERROR_HEADERS }));
}

function roomIdForPath(pathname: string): string | null {
  return ROOM_PATH.exec(pathname)?.[1] ?? null;
}

async function createRoom(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(request, 405, "METHOD_NOT_ALLOWED", "Rooms must be created with POST.");
  }
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > 1_024) {
    return errorResponse(request, 400, "BAD_REQUEST", "The room configuration is too large.");
  }

  const roomId = crypto.randomUUID().replaceAll("-", "");
  const requestHeaders = new Headers({
    "content-type": request.headers.get("content-type") ?? "application/json",
    "x-game-room-id": roomId,
  });
  const roomRequest = new Request("https://room.internal/initialize", {
    method: "POST",
    headers: requestHeaders,
    body: request.body,
  });
  return withIsolationHeaders(await env.GAME_ROOM.getByName(roomId).fetch(roomRequest));
}

async function joinRoom(request: Request, roomId: string, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(request, 405, "METHOD_NOT_ALLOWED", "A player seat must be claimed with POST.");
  }
  const roomRequest = new Request("https://room.internal/join", { method: "POST" });
  return withIsolationHeaders(await env.GAME_ROOM.getByName(roomId).fetch(roomRequest));
}

async function previewRoom(request: Request, roomId: string, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(request, 405, "METHOD_NOT_ALLOWED", "Room previews require GET.");
  }
  const roomRequest = new Request("https://room.internal/preview");
  return withIsolationHeaders(await env.GAME_ROOM.getByName(roomId).fetch(roomRequest));
}

async function connectRoom(request: Request, roomId: string, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(request, 405, "METHOD_NOT_ALLOWED", "Room sockets require GET.");
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(request, 426, "UPGRADE_REQUIRED", "Room connections require a WebSocket upgrade.");
  }
  return env.GAME_ROOM.getByName(roomId).fetch(request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/rooms") return await createRoom(request, env);
      const roomId = roomIdForPath(url.pathname);
      if (roomId) {
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
          return await connectRoom(request, roomId, env);
        }
        if (request.method === "POST") return await joinRoom(request, roomId, env);
        if (request.method === "GET") return await previewRoom(request, roomId, env);
        return errorResponse(request, 405, "METHOD_NOT_ALLOWED", "Unsupported room operation.");
      }

      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        return isHtmlOrWorkerResponse(response) ? withIsolationHeaders(response) : response;
      }
      return errorResponse(request, 404, "NOT_FOUND", "The requested resource was not found.");
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        path: url.pathname,
        message: error instanceof Error ? error.message : "Unknown error",
      }));
      return errorResponse(request, 500, "INTERNAL_ERROR", "The request could not be completed.");
    }
  },
} satisfies ExportedHandler<Env>;
