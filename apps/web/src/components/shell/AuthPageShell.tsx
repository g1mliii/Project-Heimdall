import type { ReactNode } from "react";
import { isClerkConfigured } from "@/lib/env";
import styles from "./AuthPageShell.module.css";

/**
 * Shared centered shell for the Clerk sign-in/sign-up catch-all pages (§20.1).
 *
 * The not-configured guard lives here, not in each page: `<SignIn>`/`<SignUp>`
 * require a `<ClerkProvider>` ancestor, which `app/layout.tsx` only mounts
 * when Clerk is configured. Those URLs are reachable only by typing them
 * directly (nothing links there when auth is off) — still a real page rather
 * than a crash. JSX element creation doesn't invoke the child component, so
 * the provider-less path never touches Clerk.
 */
export function AuthPageShell({
  overline,
  unavailable,
  children,
}: {
  overline: string;
  unavailable: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.wrap}>
      <span className="heimdall-overline">{overline}</span>
      {isClerkConfigured() ? (
        children
      ) : (
        <p style={{ font: "var(--type-body)", color: "var(--fg-2)", textAlign: "center" }}>
          {unavailable}
        </p>
      )}
    </div>
  );
}
