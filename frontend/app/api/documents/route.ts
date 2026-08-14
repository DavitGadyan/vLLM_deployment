import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxy(request, "/v1/documents");
}

/** Multipart upload streams through; the file is never buffered in this process. */
export async function POST(request: Request): Promise<Response> {
  return proxy(request, "/v1/documents");
}
