// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalShareUrl,
  clearClaimHandoff,
  consumeClaimHandoff,
} from "./claim-handoff";

const RUN_ID = "run_claim";

afterEach(() => {
  clearClaimHandoff(RUN_ID);
  window.history.replaceState(null, "", "/");
});

describe("desktop claim handoff", () => {
  it("moves a fragment token into tab storage and scrubs the address bar immediately", () => {
    window.history.replaceState(null, "", `/runs/${RUN_ID}#claim=tok%20en%2F%2B`);

    expect(consumeClaimHandoff(RUN_ID, true)).toBe("tok en/+");
    expect(window.location.pathname).toBe(`/runs/${RUN_ID}`);
    expect(window.location.hash).toBe("");

    // A sign-in navigation can remount the page without putting the capability
    // back into history, logs, or copied URLs.
    expect(consumeClaimHandoff(RUN_ID, true)).toBe("tok en/+");
  });

  it("scrubs legacy query links without serializing the token through the server component", () => {
    window.history.replaceState(null, "", `/runs/${RUN_ID}?view=chart&claim=legacy-secret`);

    expect(consumeClaimHandoff(RUN_ID, true)).toBe("legacy-secret");
    expect(window.location.search).toBe("?view=chart");
  });

  it("discards a token for a run the server says is already owned", () => {
    window.history.replaceState(null, "", `/runs/${RUN_ID}#claim=must-not-render`);

    expect(consumeClaimHandoff(RUN_ID, false)).toBeUndefined();
    expect(window.location.hash).toBe("");
    expect(consumeClaimHandoff(RUN_ID, true)).toBeUndefined();
  });

  it("builds share links without query or fragment claim capabilities", () => {
    expect(
      canonicalShareUrl(
        `https://heimdall.dev/runs/${RUN_ID}?view=chart&claim=query-secret#claim=fragment-secret`,
      ),
    ).toBe(`https://heimdall.dev/runs/${RUN_ID}?view=chart`);
  });
});
