import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "../components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Koven · Mission Control", template: "%s · Koven" },
  description: "Live evidence for autonomous credit and x402 payments on Hedera.",
};

export const viewport: Viewport = { themeColor: "#0b0d0c", colorScheme: "dark" };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}

