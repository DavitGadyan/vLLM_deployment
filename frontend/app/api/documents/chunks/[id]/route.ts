import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backs the citation drawer — resolves a chunk id to its source text. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  return proxy(request, `/v1/documents/chunks/${encodeURIComponent(id)}`);
}
