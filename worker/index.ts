const ERROR_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

function errorResponse(
  request: Request,
  status: 404 | 500,
  code: "NOT_FOUND" | "INTERNAL_ERROR",
  message: string,
): Response {
  const body = request.method === "HEAD"
    ? null
    : JSON.stringify({ error: { code, message } });

  return new Response(body, { status, headers: ERROR_HEADERS });
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const response = await env.ASSETS.fetch(request);

      if (response.status !== 404) {
        return response;
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
