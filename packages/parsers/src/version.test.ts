import { describe, expect, it } from "vitest";
import { captureSourceSchema } from "@heimdall/shared";

import { PARSER_VERSIONS, parserVersionString } from "./version";

describe("parser versions", () => {
  it("covers every capture source with a semver string", () => {
    for (const source of captureSourceSchema.options) {
      expect(PARSER_VERSIONS[source]).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("formats source@version", () => {
    expect(parserVersionString("capframex")).toBe("capframex@1.0.0");
  });
});
