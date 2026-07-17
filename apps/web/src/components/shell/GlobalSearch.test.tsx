// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { MAX_INDEXED_METADATA_TEXT_LENGTH } from "@heimdall/shared";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

import { GlobalSearch, type SearchLoader } from "./GlobalSearch";

const results = {
  games: [
    { id: "1", slug: "cyberpunk-2077", name: "Cyberpunk 2077" },
    { id: "2", slug: "cyberpunk-2077-ultimate", name: "Cyberpunk Ultimate" },
  ],
  hardware: [
    {
      id: "3",
      kind: "gpu" as const,
      vendor: "nvidia",
      canonicalName: "NVIDIA GeForce RTX 4070",
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("GlobalSearch (§17.6)", () => {
  it("treats a short query as normal typeahead state without loading", async () => {
    const user = userEvent.setup();
    const search = vi.fn<SearchLoader>();
    render(<GlobalSearch search={search} />);

    const input = screen.getByRole("combobox", { name: "Search games and hardware" });
    expect(input).toHaveAttribute("maxlength", String(MAX_INDEXED_METADATA_TEXT_LENGTH));
    await user.type(input, "rt");
    expect(screen.getByText("Keep typing…")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(search).not.toHaveBeenCalled();
  });

  it("debounces results while keeping hardware rows non-navigating", async () => {
    const user = userEvent.setup();
    const search = vi.fn<SearchLoader>().mockResolvedValue({ ok: true, data: results });
    render(<GlobalSearch search={search} />);

    await user.type(screen.getByRole("combobox"), "cyber");
    expect(screen.getByRole("status", { name: "Searching catalog" })).toBeInTheDocument();
    expect((await screen.findAllByRole("option"))[0]).toHaveAttribute(
      "href",
      "/games/cyberpunk-2077",
    );
    expect(search).toHaveBeenCalledOnce();

    const hardware = screen.getByRole("group", { name: "Hardware" });
    expect(within(hardware).getByText("NVIDIA GeForce RTX 4070")).toBeInTheDocument();
    expect(within(hardware).queryByRole("option")).not.toBeInTheDocument();
    expect(within(hardware).queryByRole("link")).not.toBeInTheDocument();
    expect(
      within(hardware).getByText("Hardware pages are coming — search a game to see its runs."),
    ).toBeInTheDocument();
  });

  it("moves only through game options and enters the active destination", async () => {
    const user = userEvent.setup();
    const search = vi.fn<SearchLoader>().mockResolvedValue({ ok: true, data: results });
    render(<GlobalSearch search={search} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "cyber");
    await screen.findAllByRole("option");
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute(
      "aria-activedescendant",
      expect.stringMatching(/-game-0$/),
    );
    await user.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/games/cyberpunk-2077");
  });

  it("shows empty and failure states without stale result rows", async () => {
    const user = userEvent.setup();
    const search = vi
      .fn<SearchLoader>()
      .mockResolvedValueOnce({ ok: true, data: { games: [], hardware: [] } })
      .mockResolvedValueOnce({ ok: false, code: "network", message: "internal detail" });
    render(<GlobalSearch search={search} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "nothing");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "failure");
    expect(await screen.findByText("Search unavailable — try again.")).toBeInTheDocument();
    expect(screen.queryByText("internal detail")).not.toBeInTheDocument();
  });

  it("aborts stale work and closes on Escape", async () => {
    const user = userEvent.setup();
    let firstSignal: AbortSignal | undefined;
    const search: SearchLoader = (_query, signal) => {
      firstSignal = signal;
      return new Promise(() => undefined);
    };
    render(<GlobalSearch search={search} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "cyber");
    await waitFor(() => expect(firstSignal).toBeDefined());
    await user.clear(input);
    expect(firstSignal?.aborted).toBe(true);
    await user.type(input, "rt");
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Search results" })).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
  });
});
