import type { Metadata, Viewport } from "next";

import { AppShell } from "@/components/app-shell";
import { ToastProvider } from "@/components/ui/toast";
import { themeScript } from "@/lib/theme-store";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: process.env.NEXT_PUBLIC_APP_NAME ?? "Support Console",
    template: `%s · ${process.env.NEXT_PUBLIC_APP_NAME ?? "Support Console"}`,
  },
  description:
    "Configure and test a retrieval-grounded customer support assistant served by vLLM.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1a1c" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Runs before first paint so dark-mode users never see a white flash. */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ToastProvider>
          <AppShell>{children}</AppShell>
        </ToastProvider>
      </body>
    </html>
  );
}
