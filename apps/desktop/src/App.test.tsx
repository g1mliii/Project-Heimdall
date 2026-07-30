/**
 * The four kit screens, rendered from fixture data (§22.4).
 *
 * The IPC module is mocked wholesale so this runs on the ubuntu CI runner with
 * no Tauri runtime — the Windows-only half is covered by `cargo test`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CaptureResult, DeclaredHardware, Environment } from "./lib/ipc";

const ipc = vi.hoisted(() => ({
  getEnvironment: vi.fn(),
  getHardware: vi.fn(),
  getHardwareForPid: vi.fn(),
  checkForUpdate: vi.fn(),
  installUpdate: vi.fn(),
  getForegroundGame: vi.fn(),
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
  captureRunning: vi.fn(),
  setHotkey: vi.fn(),
  beginUpload: vi.fn(),
  endUpload: vi.fn(),
  discardPayload: vi.fn(),
  openSetupGuide: vi.fn(),
  openClaim: vi.fn(),
  pendingCrashReport: vi.fn(),
  openCrashReport: vi.fn(),
  dismissCrashReport: vi.fn(),
  preparePayload: vi.fn(),
  putPreparedPayload: vi.fn(),
  on: vi.fn(),
  EVENTS: {
    started: "capture://started",
    rows: "capture://rows",
    ended: "capture://ended",
    hotkey: "capture://hotkey",
    hotkeyState: "capture://hotkey-state",
    trayToggle: "capture://toggle",
    uploadProgress: "upload://progress",
  },
}));

vi.mock("./lib/ipc", () => ipc);
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), hide: vi.fn() }),
}));
vi.mock("./lib/transport", () => ({
  createDesktopTransport: vi.fn(() => ({ fetch: vi.fn(), putWithProgress: vi.fn() })),
  createSigner: vi.fn(() => vi.fn()),
}));

const uploadCaptureBytes = vi.hoisted(() => vi.fn());
vi.mock("@heimdall/ingest-client", () => ({ uploadCaptureBytes }));

const { App } = await import("./App");

const READY_ENV: Environment = {
  performanceLogUsers: true,
  sidecarPresent: true,
  captureTool: "PresentMon 2.4.1",
  hotkey: { status: "registered", accelerator: "Shift+F11" },
  apiBaseUrl: "http://localhost:3000",
  appVersion: "0.1.0",
  signingAvailable: true,
  updatesEnabled: false,
};

const HARDWARE: DeclaredHardware = {
  hardware: {
    gpu: "AMD Radeon RX 9070 XT",
    cpu: "AMD Ryzen 7 9800X3D 8-Core Processor",
    gpuDriver: "26.7.1",
    resolution: "2560x1440",
    ramSpeedMtps: 6000,
  },
  methodology: { captureTool: "PresentMon 2.4.1", hags: true },
};

const CAPTURE_HARDWARE: DeclaredHardware = {
  hardware: {
    ...HARDWARE.hardware,
    gpu: "NVIDIA GeForce RTX 5090",
    gpuDriver: "590.12",
    resolution: "3840x2160",
  },
  methodology: { captureTool: "PresentMon 2.4.1", hags: false },
};

/** 200 frames at ~10 ms — comfortably past `minFramesPerRun`. */
function csvFixture(rows = 200): string {
  const lines = ["Application,ProcessID,SwapChainAddress,CPUStartTime,FrameTime"];
  for (let i = 0; i < rows; i += 1) {
    lines.push(`game.exe,42,0xAAAA,${(3500 + i * 10) / 1000},10`);
  }
  return `${lines.join("\n")}\n`;
}

const CAPTURE_RESULT: CaptureResult = {
  target: { pid: 42, process: "Cyberpunk2077.exe" },
  frames: 200,
  csv: csvFixture(),
};

/** Event name → the handler App registered for it. */
const handlers = new Map<string, (payload: unknown) => void>();

beforeEach(() => {
  handlers.clear();
  for (const mock of Object.values(ipc)) {
    if (typeof mock === "function") (mock as ReturnType<typeof vi.fn>).mockReset();
  }
  uploadCaptureBytes.mockReset();
  ipc.getEnvironment.mockResolvedValue(READY_ENV);
  ipc.getHardware.mockResolvedValue(HARDWARE);
  ipc.getHardwareForPid.mockResolvedValue(HARDWARE);
  ipc.checkForUpdate.mockResolvedValue(null);
  ipc.installUpdate.mockResolvedValue(undefined);
  ipc.pendingCrashReport.mockResolvedValue(null);
  ipc.startCapture.mockImplementation(async () => {
    const started = { pid: 42, process: "Cyberpunk2077.exe" };
    handlers.get("capture://started")?.(started);
    return started;
  });
  ipc.stopCapture.mockResolvedValue(CAPTURE_RESULT);
  ipc.openClaim.mockResolvedValue(undefined);
  ipc.beginUpload.mockResolvedValue(undefined);
  ipc.endUpload.mockResolvedValue(undefined);
  ipc.discardPayload.mockResolvedValue(undefined);
  // Always keep the most recent handler. Unlisten is a no-op on purpose: the
  // effect re-registers when detected hardware arrives, and an async cleanup
  // racing that re-registration would drop the live listener.
  ipc.on.mockImplementation(async (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return () => {};
  });
});

async function renderReady() {
  render(<App />);
  await screen.findByText("Ready to capture");
}

describe("onboarding screen", () => {
  it("shows the setup checklist when the account is not in Performance Log Users", async () => {
    ipc.getEnvironment.mockResolvedValue({ ...READY_ENV, performanceLogUsers: false });
    render(<App />);

    expect(await screen.findByText("One-time setup")).toBeInTheDocument();
    expect(
      screen.getByText("This account is in Performance Log Users"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Add the account to the group, then sign out and back in/),
    ).toBeInTheDocument();
    // The user is not trapped here.
    expect(screen.getByRole("button", { name: /Continue anyway/ })).toBeInTheDocument();
  });

  it("reports a missing sidecar against the pinned tool version", async () => {
    ipc.getEnvironment.mockResolvedValue({ ...READY_ENV, sidecarPresent: false });
    render(<App />);
    expect(
      await screen.findByText("Bundled capture tool detected (PresentMon 2.4.1)"),
    ).toBeInTheDocument();
  });

  it("goes straight to ready when both checks pass", async () => {
    await renderReady();
    expect(screen.queryByText("One-time setup")).not.toBeInTheDocument();
  });
});

describe("ready screen", () => {
  it("shows the declared hardware and the live hotkey", async () => {
    await renderReady();
    expect(screen.getByText("AMD Radeon RX 9070 XT")).toBeInTheDocument();
    expect(screen.getByText("AMD Ryzen 7 9800X3D 8-Core Processor")).toBeInTheDocument();
    expect(screen.getByText("26.7.1")).toBeInTheDocument();
    expect(screen.getByText("Shift+F11")).toBeInTheDocument();
    expect(screen.getByText(/Press Shift\+F11 in-game/)).toBeInTheDocument();
  });

  it("names a hotkey conflict instead of silently doing nothing", async () => {
    ipc.getEnvironment.mockResolvedValue({
      ...READY_ENV,
      hotkey: {
        status: "conflict",
        accelerator: "Shift+F11",
        message: "Shift+F11 is already held by another application.",
      },
    });
    render(<App />);

    expect(await screen.findByText("Capture hotkey is not active")).toBeInTheDocument();
    expect(screen.getByText("Shift+F11 (unavailable)")).toBeInTheDocument();
    // The button still works, so the client is usable with a dead hotkey.
    expect(screen.getByRole("button", { name: /Start capture/ })).toBeEnabled();
  });

  it("checks the signed release channel and offers an explicit install", async () => {
    ipc.getEnvironment.mockResolvedValue({ ...READY_ENV, updatesEnabled: true });
    ipc.checkForUpdate.mockResolvedValue({ currentVersion: "0.1.0", version: "0.2.0" });
    await renderReady();

    expect(await screen.findByText("Heimdall Capture 0.2.0 is available")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Install and restart" }));
    expect(ipc.installUpdate).toHaveBeenCalledTimes(1);
  });
});

describe("capturing screen", () => {
  it("serializes competing start intents before React can render the busy state", async () => {
    let resolveStart!: (value: { pid: number; process: string }) => void;
    ipc.startCapture.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await renderReady();
    const button = screen.getByRole("button", { name: /Start capture/ });

    await act(async () => {
      button.click();
      button.click();
    });
    expect(ipc.startCapture).toHaveBeenCalledTimes(1);

    handlers.get("capture://started")?.({ pid: 42, process: "Cyberpunk2077.exe" });
    resolveStart({ pid: 42, process: "Cyberpunk2077.exe" });
    expect(await screen.findByText("Capturing…")).toBeInTheDocument();
  });

  it("does not resurrect capturing when an immediate exit beats the invoke result", async () => {
    let resolveStart!: (value: { pid: number; process: string }) => void;
    ipc.startCapture.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));

    await act(async () => {
      handlers.get("capture://started")?.({ pid: 42, process: "game.exe" });
      handlers.get("capture://ended")?.({ frames: 200, reason: "exited" });
    });
    expect(await screen.findByText("Capture complete")).toBeInTheDocument();

    await act(async () => resolveStart({ pid: 42, process: "game.exe" }));
    expect(screen.getByText("Capture complete")).toBeInTheDocument();
    expect(screen.queryByText("Capturing…")).not.toBeInTheDocument();
  });

  it("switches to the live view and counts frames from streamed rows", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));

    expect(await screen.findByText("Capturing…")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
    expect(ipc.getHardwareForPid).toHaveBeenCalledWith(42);

    await act(async () => {
      handlers.get("capture://rows")?.({
        lines: ["Application,FrameTime", "game.exe,10", "game.exe,10"],
        frames: 2,
      });
    });

    expect(await screen.findByText("2 frames")).toBeInTheDocument();
    expect(screen.getByText("100.0 fps")).toBeInTheDocument();
    expect(screen.getByText("Recommended capture length: 60 seconds.")).toBeInTheDocument();
  });

  it("explains a sidecar that ends on its own", async () => {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Capturing…");

    await act(async () => {
      handlers.get("capture://ended")?.({ frames: 200, reason: "exited" });
    });

    // It drains what was recorded rather than stranding the user.
    expect(await screen.findByText("Capture complete")).toBeInTheDocument();
    expect(screen.getByText(/the game exited/)).toBeInTheDocument();
  });

  it("does not call stop twice when termination races a requested stop", async () => {
    let resolveStop!: (value: CaptureResult) => void;
    ipc.stopCapture.mockReturnValue(
      new Promise((resolve) => {
        resolveStop = resolve;
      }),
    );
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Capturing…");

    await act(async () => {
      screen.getByRole("button", { name: /Stop & analyze/ }).click();
      handlers.get("capture://ended")?.({ frames: 200, reason: "exited" });
    });
    expect(ipc.stopCapture).toHaveBeenCalledTimes(1);

    resolveStop(CAPTURE_RESULT);
    expect(await screen.findByText("Capture complete")).toBeInTheDocument();
    expect(ipc.stopCapture).toHaveBeenCalledTimes(1);
  });
});

describe("complete screen", () => {
  async function reachComplete() {
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Capturing…");
    await userEvent.click(screen.getByRole("button", { name: /Stop & analyze/ }));
    await screen.findByText("Capture complete");
  }

  it("shows the three tiers computed by the shared parser", async () => {
    await reachComplete();
    expect(screen.getByText("Avg")).toBeInTheDocument();
    expect(screen.getByText("1% low")).toBeInTheDocument();
    expect(screen.getByText("0.1%")).toBeInTheDocument();
    // 10 ms frames → 100 FPS, straight out of computeRunSummary.
    expect(screen.getAllByText("100").length).toBeGreaterThan(0);
  });

  it("names the undeclared comparability fields", async () => {
    await reachComplete();
    // Resolution is prefilled from detection; the rest are not guessed.
    expect(screen.getByText("8 missing")).toBeInTheDocument();
    // Labels come from COMPARABILITY_FIELD_LABELS in @heimdall/shared, so this
    // is the same wording the run page uses for the same gaps.
    expect(
      screen.getByText(
        "Undeclared: Scene or route, Settings preset, Upscaler, Ray tracing, Graphics API, VSync, VRR, Scene type.",
      ),
    ).toBeInTheDocument();
  });

  it("is honest that the signature covers frame data only", async () => {
    await reachComplete();
    expect(screen.getByText("Frame data signed and ready to upload")).toBeInTheDocument();
    expect(
      screen.getByText(/declared, not signed. It is recorded as evidence and never decides/),
    ).toBeInTheDocument();
  });

  it("says so when the build carries no signing key", async () => {
    ipc.getEnvironment.mockResolvedValue({ ...READY_ENV, signingAvailable: false });
    await reachComplete();
    expect(screen.getByText("Ready to upload (this build is unsigned)")).toBeInTheDocument();
  });

  it("uploads and hands the claim token to the browser", async () => {
    uploadCaptureBytes.mockResolvedValue({
      ok: true,
      runId: "run_abc",
      managementToken: "plaintext-token",
      captureSource: "presentmon",
      summary: {},
      warnings: [],
    });
    await reachComplete();
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    await waitFor(() => expect(ipc.openClaim).toHaveBeenCalledWith("run_abc", "plaintext-token"));
    expect(ipc.beginUpload).toHaveBeenCalledTimes(1);
    expect(ipc.endUpload).toHaveBeenCalledTimes(1);
    const [, options] = uploadCaptureBytes.mock.calls[0]!;
    expect(options.hardware).toEqual(HARDWARE.hardware);
    expect(options.methodology.captureTool).toBe("PresentMon 2.4.1");
    expect(options.methodology.hags).toBe("enabled");
    // Prefilled from the foreground process name.
    expect(options.game).toBe("Cyberpunk2077");
    expect(await screen.findByText("Uploaded")).toBeInTheDocument();
  });

  it("retains ambiguous-finalize recovery until the claim page opens", async () => {
    uploadCaptureBytes.mockResolvedValue({
      ok: false,
      code: "finalize-failed",
      message: "The finalize response was lost.",
      recovery: { runId: "run_recovery", managementToken: "recovery-token" },
    });
    ipc.openClaim.mockRejectedValueOnce(new Error("No browser is configured"));
    await reachComplete();
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    expect(await screen.findByText("Upload status needs recovery")).toBeInTheDocument();
    expect(screen.getByText(/one-time management credential is still held/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Upload & share/ })).not.toBeInTheDocument();

    ipc.openClaim.mockResolvedValueOnce(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Open claim page" }));
    await waitFor(() =>
      expect(ipc.openClaim).toHaveBeenLastCalledWith("run_recovery", "recovery-token"),
    );
    expect(await screen.findByText("Uploaded")).toBeInTheDocument();
    expect(screen.getByText(/recovery page opened/)).toBeInTheDocument();
  });

  it("keeps a successful upload claimable when browser handoff fails", async () => {
    uploadCaptureBytes.mockResolvedValue({
      ok: true,
      runId: "run_handoff",
      managementToken: "handoff-token",
      captureSource: "presentmon",
      summary: {},
      warnings: [],
    });
    ipc.openClaim.mockRejectedValueOnce(new Error("Browser opener failed"));
    await reachComplete();
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    expect(
      await screen.findByText("Run uploaded — browser handoff failed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open claim page" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Capture another run" })).not.toBeInTheDocument();

    ipc.openClaim.mockResolvedValueOnce(undefined);
    await userEvent.click(screen.getByRole("button", { name: "Open claim page" }));
    expect(await screen.findByRole("button", { name: "Capture another run" })).toBeEnabled();
  });

  it("does not allow an update to restart the app during an upload", async () => {
    ipc.getEnvironment.mockResolvedValue({ ...READY_ENV, updatesEnabled: true });
    ipc.checkForUpdate.mockResolvedValue({ currentVersion: "0.1.0", version: "0.2.0" });
    let resolveUpload!: (value: {
      ok: false;
      code: string;
      message: string;
    }) => void;
    uploadCaptureBytes.mockReturnValue(
      new Promise((resolve) => {
        resolveUpload = resolve;
      }),
    );
    await reachComplete();
    await screen.findByText("Heimdall Capture 0.2.0 is available");
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    expect(await screen.findByRole("button", { name: "Install and restart" })).toBeDisabled();
    expect(ipc.installUpdate).not.toHaveBeenCalled();

    await act(async () =>
      resolveUpload({ ok: false, code: "network", message: "Upload interrupted" }),
    );
    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install and restart" })).toBeEnabled();
  });

  it("waits for captured-process hardware before finalizing a short capture", async () => {
    let resolveHardware!: (hardware: DeclaredHardware) => void;
    ipc.getHardwareForPid.mockReturnValue(
      new Promise((resolve) => {
        resolveHardware = resolve;
      }),
    );
    uploadCaptureBytes.mockResolvedValue({
      ok: true,
      runId: "run_process_hardware",
      managementToken: "plaintext-token",
      captureSource: "presentmon",
      summary: {},
      warnings: [],
    });

    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Capturing…");
    await userEvent.click(screen.getByRole("button", { name: /Stop & analyze/ }));
    await waitFor(() => expect(ipc.stopCapture).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Capture complete")).not.toBeInTheDocument();

    await act(async () => resolveHardware(CAPTURE_HARDWARE));
    await screen.findByText("Capture complete");
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    await waitFor(() => expect(uploadCaptureBytes).toHaveBeenCalledTimes(1));
    const [, options] = uploadCaptureBytes.mock.calls[0]!;
    expect(options.hardware).toEqual(CAPTURE_HARDWARE.hardware);
    expect(options.methodology.hags).toBe("disabled");
  });

  it("surfaces an upload failure without losing the capture", async () => {
    uploadCaptureBytes.mockResolvedValue({
      ok: false,
      code: "rate-limited",
      message: "Too many uploads. Try again in a minute.",
    });
    await reachComplete();
    await userEvent.click(screen.getByRole("button", { name: /Upload & share/ }));

    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByText("Too many uploads. Try again in a minute.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Upload & share/ })).toBeEnabled();
  });

  it("discard drops the held payload in Rust as well as the UI state", async () => {
    await reachComplete();
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(ipc.discardPayload).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Ready to capture")).toBeInTheDocument();
  });

  it("rejects a capture that is too short, rather than uploading it", async () => {
    ipc.stopCapture.mockResolvedValue({ ...CAPTURE_RESULT, frames: 3, csv: csvFixture(3) });
    await renderReady();
    await userEvent.click(screen.getByRole("button", { name: /Start capture/ }));
    await screen.findByText("Capturing…");
    await userEvent.click(screen.getByRole("button", { name: /Stop & analyze/ }));

    expect(await screen.findByText("Capture notice")).toBeInTheDocument();
    expect(screen.getByText(/Capture for longer/)).toBeInTheDocument();
    expect(screen.getByText("Ready to capture")).toBeInTheDocument();
  });
});

describe("crash report", () => {
  it("offers the previous run's local log without having sent anything", async () => {
    ipc.pendingCrashReport.mockResolvedValue("panic: index out of bounds");
    render(<App />);

    expect(
      await screen.findByText("Heimdall Capture closed unexpectedly last time"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing has been sent/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(ipc.dismissCrashReport).toHaveBeenCalledTimes(1);
  });
});
