import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The backend's readiness report, proxied like every other backend call.
 *
 * Returns `{ ready, checks: { database, vllm, embeddings } }`. Useful because
 * "the assistant isn't answering" has several very different causes — no
 * database, no model server, no embedding service — and from the browser they
 * are otherwise indistinguishable. The e2e chat specs use it to skip with a
 * specific reason rather than time out; an operator can hit it directly.
 *
 * A non-ready backend still answers this with 200 and `ready: false`, so a
 * failed fetch here means the backend itself is unreachable.
 */
export async function GET(request: Request): Promise<Response> {
  return proxy(request, "/readyz");
}
