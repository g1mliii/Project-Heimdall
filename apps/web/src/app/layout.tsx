import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Space_Grotesk, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "@heimdall/ui/styles.css";
import { TopBar } from "@/components/shell/TopBar";
import { clerkAppearance } from "@/lib/clerk-appearance";
import { isClerkConfigured } from "@/lib/env";

// Self-host the three design-system faces. Each exposes a CSS variable that the
// @heimdall/ui typography tokens (--font-display / --font-sans / --font-mono)
// resolve to — see packages/ui/src/tokens/typography.css.
const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space-grotesk",
  display: "swap",
});
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-hanken-grotesk",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Heimdall",
  description: "Open-source game benchmarking: capture, share, and auto-diagnose frame-time data.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  const authEnabled = isClerkConfigured();
  // base.css paints <body> with var(--bg-base) — the dark-first instrument canvas.
  const body = (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <TopBar authEnabled={authEnabled} />
        {children}
      </body>
    </html>
  );
  // Anonymous-only dev/CI (no Clerk keys, §20.1a) must boot without a
  // <ClerkProvider> — it throws without a publishable key.
  return authEnabled ? <ClerkProvider appearance={clerkAppearance}>{body}</ClerkProvider> : body;
}
