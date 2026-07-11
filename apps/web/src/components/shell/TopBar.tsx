"use client";

/**
 * Minimal app chrome (Phase 5 slice of design/ui_kits/web/AppShell.jsx):
 * logo + wordmark, nav tabs, primary upload CTA. Global search and the
 * account menu land with later phases — no dead controls until then.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, Tabs } from "@heimdall/ui";

function UploadIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v12" />
      <path d="m17 8-5-5-5 5" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </svg>
  );
}

const NAV = [
  { value: "/", label: "Benchmarks" },
  { value: "/upload", label: "Upload" },
];

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <header
      style={{
        height: "var(--topbar-h)",
        display: "flex",
        alignItems: "center",
        gap: "var(--space-6)",
        paddingLeft: "var(--space-6)",
        paddingRight: "var(--space-6)",
        borderBottomWidth: "var(--border-thin)",
        borderBottomStyle: "solid",
        borderBottomColor: "var(--line-1)",
        background: "color-mix(in srgb, var(--bg-base) 82%, transparent)",
        backdropFilter: "var(--blur-md)",
        position: "sticky",
        top: 0,
        zIndex: 20,
      }}
    >
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          textDecoration: "none",
        }}
      >
        <img src="/logo-mark.svg" width={28} height={28} alt="" />
        <span
          style={{
            font: "var(--type-subheading)",
            letterSpacing: "var(--tracking-tight)",
            color: "var(--fg-1)",
          }}
        >
          Heimdall
        </span>
      </Link>
      <Tabs
        tabs={NAV}
        value={pathname}
        onChange={(href) => router.push(href)}
        aria-label="Primary navigation"
      />
      <div style={{ flex: 1 }} />
      <Link href="/upload" style={{ textDecoration: "none" }}>
        <Button variant="primary" iconLeft={<UploadIcon />}>
          Upload log
        </Button>
      </Link>
    </header>
  );
}
