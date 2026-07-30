// @vitest-environment jsdom

/**
 * Desktop claim handoff on the web side (§22.5).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { ClaimRunCard } from "./ClaimRunCard";

afterEach(cleanup);

function renderCard(fetcher: typeof fetch, onConsumed?: () => void) {
  render(
    <ClaimRunCard
      runId="run_abc"
      token="plaintext-token"
      fetcher={fetcher}
      onConsumed={onConsumed}
    />,
  );
}

describe("ClaimRunCard", () => {
  it("sends the handoff token as a bearer credential, never in the body", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const onConsumed = vi.fn();
    renderCard(fetcher as unknown as typeof fetch, onConsumed);

    await userEvent.click(screen.getByRole("button", { name: "Claim this run" }));

    await waitFor(() => expect(screen.getByText("Run claimed")).toBeInTheDocument());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("/api/runs/run_abc/claim");
    expect(init).toMatchObject({
      method: "POST",
      headers: { authorization: "Bearer plaintext-token" },
    });
    expect(init.body).toBeUndefined();

    expect(onConsumed).toHaveBeenCalledOnce();
  });

  it("asks the user to sign in on a 401 instead of guessing at auth state", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    renderCard(fetcher as unknown as typeof fetch);

    await userEvent.click(screen.getByRole("button", { name: "Claim this run" }));
    expect(await screen.findByText(/Sign in first, then claim/)).toBeInTheDocument();
    // The card stays, so the tab-scoped token is still usable after signing in.
    expect(screen.getByRole("button", { name: "Claim this run" })).toBeInTheDocument();
  });

  it("does not pretend to know why a 404 happened", async () => {
    // The route makes wrong-token, already-claimed and no-such-run
    // indistinguishable on purpose; the copy must not claim otherwise.
    const fetcher = vi.fn().mockResolvedValue(
      Response.json({ error: { code: "not-found", message: "run not found" } }, { status: 404 }),
    );
    renderCard(fetcher as unknown as typeof fetch);

    await userEvent.click(screen.getByRole("button", { name: "Claim this run" }));
    expect(
      await screen.findByText(
        "This claim link has already been used, or it does not match this run.",
      ),
    ).toBeInTheDocument();
  });

  it("surfaces a transport failure as a typed message, not a crash", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("network dropped"));
    renderCard(fetcher as unknown as typeof fetch);

    await userEvent.click(screen.getByRole("button", { name: "Claim this run" }));
    expect(await screen.findByText("network dropped")).toBeInTheDocument();
  });
});
