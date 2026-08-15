import { Badge } from "@/components/ui/badge";
import { AlertIcon, UserIcon } from "@/components/ui/icons";

/**
 * A worked example of the assistant answering, shown inside the architecture
 * panel.
 *
 * The point of the Architecture tab is to explain a system a client cannot see.
 * Somewhere in that explanation they need to be reminded what the thing actually
 * looks like in use — and the Support Assistant node is where they ask it. This
 * is that reminder: one real-shaped exchange, showing the two behaviours that
 * matter commercially. It cites its source, and it hands off rather than
 * guessing.
 *
 * Rendered from the same components' markup rather than shipped as a captured
 * PNG, for the reason the whole tab is static data: it has to draw with the
 * backend stopped, it stays legible at any zoom in a recording, and it cannot
 * drift out of date with the design system the way an image would.
 *
 * The figures are labelled as an example below, not as a measurement. Real
 * numbers for this deployment live on the Monitoring tab, where they are marked
 * live or demo.
 */
export function AssistantPreview() {
  return (
    <figure className="overflow-hidden rounded-md border border-border bg-surface">
      <div className="flex items-center gap-2 border-b border-border bg-surface-sunken px-3 py-1.5">
        <span className="size-1.5 rounded-full bg-success" aria-hidden />
        <p className="text-[11px] font-medium text-secondary">
          Northwind Outdoors · Support
        </p>
      </div>

      <div className="space-y-3 px-3 py-3">
        {/* The customer. */}
        <div className="flex justify-end">
          <div className="flex max-w-[85%] items-start gap-2">
            <div className="rounded-lg rounded-tr-sm bg-surface-active px-2.5 py-1.5">
              <p className="text-[11px] leading-relaxed text-primary">
                My tent arrived with a torn seam. It has been 3 weeks — can I still
                return it?
              </p>
            </div>
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-tertiary">
              <UserIcon className="size-2.5" />
            </span>
          </div>
        </div>

        {/* The answer, with the marker that makes it checkable. */}
        <div className="space-y-1.5">
          <p className="text-[11px] leading-relaxed text-primary">
            Yes. Damaged items can be returned within 30 days of delivery, so at 3
            weeks you are inside the window
            <span className="mx-0.5 inline-flex h-3 min-w-3 items-center justify-center rounded bg-accent-subtle px-1 align-super text-[8px] font-semibold leading-none text-accent-text">
              1
            </span>
            . Start the return from your order page and we will email you a prepaid
            label.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="neutral">1 source cited</Badge>
            <Badge variant="success">612 prompt tokens cached</Badge>
            <span className="text-[10px] tabular-nums text-tertiary">
              310 ms to first token
            </span>
          </div>
        </div>

        {/* The refusal, which is the harder thing to demonstrate and the more
            convincing one. */}
        <div className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-subtle px-2.5 py-2">
          <AlertIcon className="mt-px size-3 shrink-0 text-accent-text" />
          <div className="space-y-0.5">
            <p className="text-[10px] font-semibold text-accent-text">
              Handed off to a person
            </p>
            <p className="text-[10px] leading-relaxed text-accent-text/90">
              A follow-up asking for a goodwill credit found no matching policy, so
              the assistant escalated instead of inventing one.
            </p>
          </div>
        </div>
      </div>

      <figcaption className="border-t border-border bg-surface-sunken px-3 py-1.5 text-[10px] leading-relaxed text-tertiary">
        Example exchange, drawn with the Product tab&rsquo;s own components. The
        figures illustrate the shape of a response — measured numbers are on the
        Monitoring tab.
      </figcaption>
    </figure>
  );
}
