"use client";

/**
 * Minimal app chrome (Phase 5 slice of design/ui_kits/web/AppShell.jsx):
 * logo + wordmark, nav tabs, primary upload CTA. Global search and the
 * account menu land with later phases — no dead controls until then.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ButtonLink, NavTabs } from "@heimdall/ui";
import { icon } from "@/components/icons";
import styles from "./TopBar.module.css";

const UploadIcon = icon(
  <g>
    <path d="M12 3v12" />
    <path d="m17 8-5-5-5 5" />
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
  </g>,
);

const NAV = [
  { href: "/", label: "Benchmarks" },
  { href: "/upload", label: "Upload" },
];

export function TopBar() {
  const pathname = usePathname();

  function focusMainAfterSkip() {
    requestAnimationFrame(() => document.getElementById("main-content")?.focus());
  }

  return (
    <>
      <a className={styles.skipLink} href="#main-content" onClick={focusMainAfterSkip}>
        Skip to main content
      </a>
      <header className={styles.topbar}>
      <Link
        href="/"
        className={styles.brand}
        aria-label="Heimdall home"
      >
        <img src="/logo-mark.svg" width={28} height={28} alt="" />
        <span className={styles.wordmark}>Heimdall</span>
      </Link>
      <NavTabs
        className={styles.nav}
        tabs={NAV}
        currentHref={pathname}
        as={Link}
        aria-label="Primary navigation"
      />
      <div className={styles.spacer} />
      <ButtonLink as={Link} href="/upload" variant="primary" iconLeft={<UploadIcon size={16} />}>
        Upload log
      </ButtonLink>
      </header>
    </>
  );
}
