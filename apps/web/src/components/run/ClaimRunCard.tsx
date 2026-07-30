"use client";

/**
 * Claim affordance for a desktop handoff (§22.5).
 *
 * The desktop client opens `/runs/<id>#claim=<plaintext management token>`
 * after a successful upload. The fragment never reaches the server; the first
 * client render moves it into tab-scoped storage. That token is the SAME single-use secret the
 * browser upload flow shows once, so this card is the only place on the web
 * side that Phase 9 needed: no new route, no new auth surface.
 *
 * Deliberately does not use Clerk's `useUser()`. That hook throws without a
 * `<ClerkProvider>` ancestor, and this card renders on a page that must work
 * with auth disabled entirely (§20.1a). Signed-out is instead discovered the
 * honest way — the API answers 401 — which also means the card cannot claim to
 * know an auth state the server disagrees with.
 */

import * as React from "react";
import { Button, Diagnostic } from "@heimdall/ui";
import { readApiFailure } from "@heimdall/shared";

interface ClaimRunCardProps {
  runId: string;
  /** Plaintext token held in tab-scoped client state. */
  token: string;
  /** Clears the tab-scoped capability after a successful claim. */
  onConsumed?: () => void;
  /** Injected in tests. */
  fetcher?: typeof fetch;
}

type ClaimState =
  | { kind: "idle" }
  | { kind: "claiming" }
  | { kind: "claimed" }
  | { kind: "signed-out" }
  | { kind: "failed"; message: string };

export function ClaimRunCard({ runId, token, onConsumed, fetcher }: ClaimRunCardProps) {
  const [state, setState] = React.useState<ClaimState>({ kind: "idle" });

  const claim = React.useCallback(async () => {
    setState({ kind: "claiming" });
    try {
      const response = await (fetcher ?? fetch)(`/api/runs/${encodeURIComponent(runId)}/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status === 401) {
        setState({ kind: "signed-out" });
        return;
      }
      if (!response.ok) {
        const failure = await readApiFailure(response, "this run could not be claimed");
        setState({
          kind: "failed",
          // A 404 here covers "wrong token", "already claimed" and "no such
          // run" alike — the route makes them indistinguishable on purpose, so
          // the copy must not pretend to know which one happened.
          message:
            response.status === 404
              ? "This claim link has already been used, or it does not match this run."
              : failure.message,
        });
        return;
      }
      setState({ kind: "claimed" });
      onConsumed?.();
    } catch (error) {
      setState({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [fetcher, onConsumed, runId, token]);

  if (state.kind === "claimed") {
    return (
      <Diagnostic severity="good" title="Run claimed">
        This run is now attached to your account. You can change its visibility — including making
        it private — from your account page.
      </Diagnostic>
    );
  }

  return (
    <Diagnostic severity="info" title="Claim this run">
      This run was uploaded from the desktop capture client and is not attached to an account yet.
      Claiming it lets you manage and delete it, and change its visibility. The link works once.
      {state.kind === "signed-out" && (
        <p>Sign in first, then claim — this tab keeps the token until you do.</p>
      )}
      {state.kind === "failed" && <p>{state.message}</p>}
      <div style={{ marginTop: "var(--space-3)" }}>
        <Button loading={state.kind === "claiming"} onClick={() => void claim()}>
          Claim this run
        </Button>
      </div>
    </Diagnostic>
  );
}
