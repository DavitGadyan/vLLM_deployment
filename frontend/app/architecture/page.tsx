import { ArchitectureExplorer } from "@/components/architecture/architecture-explorer";

export const metadata = { title: "Architecture" };

// Static by design: this tab renders with the backend stopped, so a demo can
// never fail because a GPU is cold.
export default function ArchitecturePage() {
  return <ArchitectureExplorer />;
}
