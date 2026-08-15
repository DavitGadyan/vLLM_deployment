import { PageHeader } from "@/components/app-shell";
import { KnowledgeManager } from "@/components/knowledge/knowledge-manager";
import { getJson } from "@/lib/server-api";
import type { KnowledgeDocument } from "@/lib/types";

export const metadata = { title: "Knowledge base" };
export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const documents = await getJson<KnowledgeDocument[]>("/v1/documents");

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-20 pt-8 sm:px-6">
      <PageHeader
        title="Knowledge base"
        description="The documents the assistant answers from. It quotes and cites these passages, and escalates to a person when none of them answer the question."
      />
      <KnowledgeManager initial={documents} />
    </div>
  );
}
