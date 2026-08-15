import { PageHeader } from "@/components/app-shell";
import { MonitoringDashboard } from "@/components/monitoring/monitoring-dashboard";

export const metadata = { title: "Monitoring" };

export default function MonitoringPage() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-20 pt-8 sm:px-6">
      <PageHeader
        title="Monitoring"
        description="Quality, model performance, security and audit. The serving metrics say whether the GPU is healthy; the quality metrics say whether the assistant is useful. They can disagree."
      />
      <MonitoringDashboard />
    </div>
  );
}
