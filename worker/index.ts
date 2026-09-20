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

function withIsolationHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function isHtmlOrWorkerResponse(response: Response): boolean {
  if (response.status < 200 || response.status >= 300) {
    return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  return contentType.startsWith("text/html") ||
    contentType.startsWith("application/javascript") ||
    contentType.startsWith("text/javascript") ||
    contentType.startsWith("application/wasm");
}

function errorResponse(
  request: Request,
  status: 404 | 500,
  code: "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
): Response {
  const body = request.method === "HEAD"
    ? null
    : JSON.stringify({ error: { code, message } });

  return withIsolationHeaders(new Response(body, { status, headers: ERROR_HEADERS }));
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const response = await env.ASSETS.fetch(request);

      if (response.status !== 404) {
        return isHtmlOrWorkerResponse(response)
          ? withIsolationHeaders(response)
          : response;
      }

      return errorResponse(
        request,
        404,
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    } catch (error) {
      console.error(JSON.stringify({
        event: "asset_fetch_failed",
        path: new URL(request.url).pathname,
        message: error instanceof Error ? error.message : "Unknown error",
      }));

      return errorResponse(
        request,
        500,
        "INTERNAL_ERROR",
        "The application could not be loaded.",
      );
    }
  },
} satisfies ExportedHandler<Env>;
