import { proxy } from "@/lib/server-api";

// Node runtime: the proxy streams a request body, which the edge runtime does
// not support with `duplex: "half"`.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams the chat SSE response straight through.
 *
 * `request.signal` is forwarded, so closing the tab aborts this fetch, which
 * closes the backend connection, which lets the backend abort the vLLM request
 * and free its KV cache blocks. Breaking that chain anywhere means paying for
 * generation nobody reads.
 */
export async function POST(request: Request): Promise<Response> {
  return proxy(request, "/v1/chat");
}
