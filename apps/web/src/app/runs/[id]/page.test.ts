import { beforeEach, describe, expect, it, vi } from "vitest";
import { RUN_VISIBILITY, validRun } from "@heimdall/shared";

const { readVisibleRun } = vi.hoisted(() => ({ readVisibleRun: vi.fn() }));

vi.mock("@/lib/repo/runs", () => ({ readVisibleRun }));

import { generateMetadata } from "./page";

describe("run page metadata", () => {
  beforeEach(() => {
    readVisibleRun.mockReset();
  });

  it("prevents unlisted reports from being indexed or followed", async () => {
    readVisibleRun.mockResolvedValue({ ...validRun, visibility: RUN_VISIBILITY.unlisted });

    await expect(generateMetadata({ params: Promise.resolve({ id: validRun.id }) })).resolves.toMatchObject({
      robots: { index: false, follow: false },
    });
  });

  it("leaves public reports indexable", async () => {
    readVisibleRun.mockResolvedValue(validRun);

    await expect(generateMetadata({ params: Promise.resolve({ id: validRun.id }) })).resolves.not.toHaveProperty(
      "robots",
    );
  });
});
