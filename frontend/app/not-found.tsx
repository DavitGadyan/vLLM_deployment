import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-md flex-col items-center px-4 py-24 text-center">
      <p className="font-mono text-xs text-tertiary">404</p>
      <h1 className="mt-2 text-base font-semibold text-primary">Page not found</h1>
      <p className="mt-1.5 text-sm text-secondary">
        That page does not exist in the console.
      </p>
      <Button variant="secondary" className="mt-6" asChild>
        <Link href="/">Back to chat</Link>
      </Button>
    </div>
  );
}
