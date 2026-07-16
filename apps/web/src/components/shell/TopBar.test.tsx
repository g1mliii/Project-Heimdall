// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { TopBar } from "./TopBar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

afterEach(cleanup);

describe("TopBar", () => {
  it("renders the upload CTA as a single navigation link", () => {
    render(<TopBar />);

    expect(screen.getByRole("combobox", { name: "Search games and hardware" })).toBeInTheDocument();
    const upload = screen.getByRole("link", { name: "Upload log" });
    expect(upload).toHaveAttribute("href", "/upload");
    expect(upload.querySelector("button")).toBeNull();
  });

  it("uses actual links for primary navigation", () => {
    render(<TopBar />);

    const navigation = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(screen.getByRole("link", { name: "Benchmarks" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Upload" })).toHaveAttribute("href", "/upload");
    expect(navigation.querySelector('[aria-current="page"]')).toHaveTextContent("Benchmarks");
  });

  it("moves keyboard focus to the skip-link target", async () => {
    const main = document.createElement("main");
    main.id = "main-content";
    main.tabIndex = -1;
    document.body.append(main);
    try {
      const user = userEvent.setup();
      render(<TopBar />);

      await user.click(screen.getByRole("link", { name: "Skip to main content" }));

      await waitFor(() => expect(main).toHaveFocus());
    } finally {
      main.remove();
    }
  });
});
