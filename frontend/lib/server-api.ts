import "server-only";

/**
 * Server-side backend client.
 *
 * The only place that knows the backend's address. It is read from an
 * environment variable with no `NEXT_PUBLIC_` prefix, so Next.js will not
 * inline it into the client bundle — the browser talks exclusively to
 * `/api/*` route handlers, which proxy here.
 *
 * This is what lets the vLLM endpoint stay entirely inside the cluster.
 */

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8080";

export function backendUrl(path: string): string {
  return `${BACKEND_URL.replace(/\/$/, "")}${path}`;
}

/**
 * Forward a request to the backend and return its response unchanged.
 *
 * Streaming bodies pass through untouched: `fetch` gives us a ReadableStream
 * and we hand the same stream to the Response, so SSE frames reach the browser
 * as they are produced rather than being buffered here.
 */
export async function proxy(request: Request, path: string): Promise<Response> {
  const headers = new Headers();

  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  // Pass operator identity through for config attribution. When an identity
  // proxy (IAP, OIDC) is added in front, this starts carrying a real user.
  for (const header of ["x-forwarded-email", "x-operator", "x-request-id"]) {
    const value = request.headers.get(header);
    if (value) headers.set(header, value);
  }

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Required by undici when streaming a request body.
    init.duplex = "half";
  }

  const response = await fetch(backendUrl(path), init);

  const responseHeaders = new Headers();
  for (const header of ["content-type", "cache-control", "x-request-id"]) {
    const value = response.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  // Keep proxies from buffering the SSE stream into a single delivery.
  responseHeaders.set("x-accel-buffering", "no");

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

/** Fetch JSON from the backend during server rendering. */
export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(backendUrl(path), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Backend ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}
