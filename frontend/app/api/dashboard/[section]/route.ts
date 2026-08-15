import { proxy } from "@/lib/server-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The four dashboard sections share one handler. Section names are validated
// against an allowlist rather than interpolated, so this cannot be turned into
// a path-traversal proxy into arbitrary backend routes.
const SECTIONS = new Set(["quality", "performance", "security", "alignment", "audit"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ section: string }> },
): Promise<Response> {
  const { section } = await params;
  if (!SECTIONS.has(section)) {
    return Response.json({ detail: "unknown dashboard section" }, { status: 404 });
  }
  return proxy(request, `/v1/dashboard/${section}`);
}
