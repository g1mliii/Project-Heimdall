// @vitest-environment jsdom

import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";

const { uploadCapture } = vi.hoisted(() => ({ uploadCapture: vi.fn() }));

vi.mock("@/lib/upload/upload-run", () => ({ uploadCapture }));

import { UploadClient } from "./UploadClient";

afterEach(cleanup);

beforeEach(() => {
  uploadCapture.mockReset();
  uploadCapture.mockResolvedValue({ ok: false, code: "parse-failed", message: "Invalid capture" });
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
});
