import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record a human judgement about an answer.
 *
 * Proxied like every other backend call, so the browser never learns the backend
 * address. The active config version is stamped server-side rather than sent
 * from here — a judgement is about the assistant as it was configured at that
 * moment, and the browser is in no position to be authoritative about that.
 */
export async function POST(request: Request): Promise<Response> {
  return proxy(request, "/v1/feedback");
}
