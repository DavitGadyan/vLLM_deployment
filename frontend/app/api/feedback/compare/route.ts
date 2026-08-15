import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Answer one question twice, for a side-by-side judgement.
 *
 * Slower than `/api/chat` because it waits for two complete answers rather than
 * streaming one — both are needed before a comparison can be shown, so there is
 * nothing useful to stream.
 */
export async function POST(request: Request): Promise<Response> {
  return proxy(request, "/v1/feedback/compare");
}
