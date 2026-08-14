"use client";

import { Button } from "@/components/ui/button";
import { AlertIcon, RetryIcon } from "@/components/ui/icons";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-24 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg border border-border text-tertiary">
        <AlertIcon className="size-5" />
      </span>
      <h1 className="mt-4 text-base font-semibold text-primary">
        Something went wrong
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-secondary">
        The console could not load this page. If it keeps happening, the backend
        or its database may be unreachable.
      </p>
      {/* The digest is the only handle support has on the server-side log line
          for this failure, so it is shown rather than hidden. */}
      {error.digest ? (
        <code className="mt-3 rounded bg-surface-sunken px-2 py-1 font-mono text-xs text-tertiary">
          {error.digest}
        </code>
      ) : null}
      <Button variant="secondary" className="mt-6" onClick={reset}>
        <RetryIcon />
        Try again
      </Button>
    </div>
  );
}
