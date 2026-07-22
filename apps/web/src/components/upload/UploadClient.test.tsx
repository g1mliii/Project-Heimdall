// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { uploadCapture, useUser } = vi.hoisted(() => ({
  uploadCapture: vi.fn(),
  useUser: vi.fn(() => ({ isSignedIn: false })),
}));

vi.mock("@/lib/upload/upload-run", () => ({ uploadCapture }));
// §20.2: the private-visibility option is Clerk-gated behind `authEnabled`.
// Stub the hook rather than requiring a real <ClerkProvider> in tests.
vi.mock("@clerk/nextjs", () => ({ useUser }));

import { UploadClient } from "./UploadClient";

afterEach(cleanup);

beforeEach(() => {
  uploadCapture.mockReset();
  uploadCapture.mockResolvedValue({ ok: false, code: "parse-failed", message: "Invalid capture" });
  useUser.mockReset();
  useUser.mockReturnValue({ isSignedIn: false });
});

describe("UploadClient visibility (§20.2d)", () => {
  it("offers only unlisted/public when auth is disabled", () => {
    render(<UploadClient />);
    expect(screen.getByRole("button", { name: "Unlisted" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Public" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Private" })).toBeNull();
  });

  it("offers only unlisted/public when auth is enabled but signed out", () => {
    useUser.mockReturnValue({ isSignedIn: false });
    render(<UploadClient authEnabled />);
    expect(screen.queryByRole("button", { name: "Private" })).toBeNull();
  });

  it("offers private when auth is enabled and signed in, and sends it on upload", async () => {
    useUser.mockReturnValue({ isSignedIn: true });
    const user = userEvent.setup();
    const { container } = render(<UploadClient authEnabled />);

    await user.click(screen.getByRole("button", { name: "Private" }));
    await user.type(screen.getByLabelText("Game"), "Test Game");
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["capture"], "capture.csv", { type: "text/csv" }));

    await waitFor(() => expect(uploadCapture).toHaveBeenCalledTimes(1));
    const [, options] = uploadCapture.mock.calls[0]!;
    expect(options).toMatchObject({ visibility: "private" });
  });
});

describe("UploadClient reproducibility details", () => {
  it("does not send a retained benchmark-set label after details are disabled", async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadClient />);

    await user.type(screen.getByLabelText("Game"), "Test Game");
    await user.click(screen.getByRole("switch", { name: "Include" }));
    await user.type(screen.getByLabelText("Benchmark set"), "my repeatable run");
    await user.click(screen.getByRole("switch", { name: "Include" }));

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["capture"], "capture.csv", { type: "text/csv" }));

    await waitFor(() => expect(uploadCapture).toHaveBeenCalledTimes(1));
    const [, options] = uploadCapture.mock.calls[0]!;
    expect(options).toMatchObject({ game: "Test Game", visibility: "unlisted" });
    expect(options).not.toHaveProperty("methodology");
    expect(options).not.toHaveProperty("benchmarkSetId");
    expect(options).not.toHaveProperty("benchmarkSetSecret");
    expect(options).not.toHaveProperty("isWarmup");
  });

  it("blocks a fractional frame cap before parsing or uploading a capture", async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadClient />);

    await user.type(screen.getByLabelText("Game"), "Test Game");
    await user.click(screen.getByRole("switch", { name: "Include" }));
    await user.type(screen.getByLabelText("Frame cap"), "59.94");

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["capture"], "capture.csv", { type: "text/csv" }));

    expect(screen.getByText("Frame cap must be a positive whole number.")).toBeInTheDocument();
    expect(uploadCapture).not.toHaveBeenCalled();
  });

  it("sends a declared resolution for captures without a hardware inventory", async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadClient />);

    await user.type(screen.getByLabelText("Game"), "Test Game");
    await user.click(screen.getByRole("switch", { name: "Include" }));
    await user.type(screen.getByLabelText("Resolution"), "2560x1440");

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["capture"], "capture.csv", { type: "text/csv" }));

    await waitFor(() => expect(uploadCapture).toHaveBeenCalledTimes(1));
    const [, options] = uploadCapture.mock.calls[0]!;
    expect(options.methodology).toMatchObject({ resolution: "2560x1440" });
  });

  it("normalizes a declared graphics API before upload", async () => {
    const user = userEvent.setup();
    const { container } = render(<UploadClient />);

    await user.type(screen.getByLabelText("Game"), "Test Game");
    await user.click(screen.getByRole("switch", { name: "Include" }));
    await user.type(screen.getByLabelText("Graphics API"), "DX12");

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await user.upload(fileInput!, new File(["capture"], "capture.csv", { type: "text/csv" }));

    await waitFor(() => expect(uploadCapture).toHaveBeenCalledTimes(1));
    const [, options] = uploadCapture.mock.calls[0]!;
    expect(options.methodology).toMatchObject({ graphicsApi: "dx12" });
  });
});
