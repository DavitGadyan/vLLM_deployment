import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return proxy(request, "/v1/config");
}

export async function PUT(request: Request): Promise<Response> {
  return proxy(request, "/v1/config");
}
