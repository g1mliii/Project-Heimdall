// @vitest-environment jsdom

import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

    const upload = screen.getByRole("link", { name: "Upload log" });
    expect(upload).toHaveAttribute("href", "/upload");
    expect(upload.querySelector("button")).toBeNull();
  });
});
