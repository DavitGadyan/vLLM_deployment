import { PageHeader } from "@/components/app-shell";
import { ConfigForm } from "@/components/config/config-form";
import { getJson } from "@/lib/server-api";
import type { ConfigVersion, ConfigVersionSummary } from "@/lib/types";

export const metadata = { title: "Configuration" };
export const dynamic = "force-dynamic";

export default async function ConfigPage() {
  // Fetched server-side so the form renders populated on first paint rather
  // than flashing empty fields and then filling in.
  const [config, versions] = await Promise.all([
    getJson<ConfigVersion>("/v1/config"),
    getJson<ConfigVersionSummary[]>("/v1/config/versions"),
  ]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-20 pt-8 sm:px-6">
      <PageHeader
        title="Configuration"
        description="Everything here compiles into the system prompt the model receives before every question. The preview on the right shows exactly what that looks like."
      />
      <ConfigForm initialConfig={config} initialVersions={versions} />
    </div>
  );
}
