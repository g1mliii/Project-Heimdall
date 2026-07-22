"use client";

/**
 * App chrome (Phase 5 slice of design/ui_kits/web/AppShell.jsx, account menu
 * added §20.1): logo + wordmark, nav tabs, global catalog search, primary
 * upload CTA, and — only when Clerk is configured — the sign-in/account
 * menu. `authEnabled` is computed server-side (`isClerkConfigured()` in
 * `app/layout.tsx`) so an unconfigured deployment renders identically to the
 * pre-auth app instead of mounting Clerk components with no provider.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Show, SignInButton, UserButton } from "@clerk/nextjs";
import { Button, ButtonLink, NavTabs } from "@heimdall/ui";
import { icon } from "@/components/icons";
import { GlobalSearch } from "./GlobalSearch";
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

export function TopBar({ authEnabled = false }: { authEnabled?: boolean }) {
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
      <GlobalSearch />
      <div className={styles.spacer} />
      {authEnabled && (
        <div className={styles.account}>
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button variant="ghost" size="sm">
                Sign in
              </Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link href="/account" className={styles.accountLink}>
              My runs
            </Link>
            <UserButton />
          </Show>
        </div>
      )}
      <ButtonLink as={Link} href="/upload" variant="primary" iconLeft={<UploadIcon size={16} />}>
        Upload log
      </ButtonLink>
      </header>
    </>
  );
}
