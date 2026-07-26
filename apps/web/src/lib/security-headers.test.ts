/**
 * Security-header regression (§8.5.6 + §20). The CSP is authored by hand in
 * next.config.ts, so nothing else catches a directive that forgets a host the
 * app actually depends on. The Clerk case is the one that already bit us:
 * `connect-src`/`frame-src` listed Clerk but `script-src` did not, so
 * `clerk.browser.js` was blocked, the SDK never booted, and every auth surface
 * failed to hydrate — invisible to unit tests and only caught by account.spec.ts.
 */

import { describe, expect, it } from "vitest";

import nextConfig, { CLERK_HOSTS, clerkFrontendApiHost } from "../../next.config";

async function cspDirectives(): Promise<Map<string, string[]>> {
  const routes = await nextConfig.headers!();
  const header = routes
    .flatMap((route) => route.headers)
    .find((entry) => entry.key === "Content-Security-Policy");
  expect(header, "a Content-Security-Policy header must be served").toBeDefined();

  return new Map(
    header!.value.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name!, sources];
    }),
  );
}

describe("content security policy (§8.5.6)", () => {
  it("grants Clerk every directive its SDK needs, script-src included", async () => {
    const directives = await cspDirectives();
    const clerkHosts = CLERK_HOSTS.split(" ");

    // script-src is the one that was missing: the SDK fetches clerk.browser.js
    // from the instance host, so a `'self'`-only script policy breaks sign-in.
    for (const directive of ["script-src", "connect-src", "frame-src"]) {
      const sources = directives.get(directive) ?? [];
      for (const host of clerkHosts) {
        expect(sources, `${directive} must allow ${host}`).toContain(host);
      }
    }
  });

  it("names a real host in every Clerk source, never an unmatchable pattern", async () => {
    // `https://*.clerk.accounts` shipped here once: no TLD, so it matches no
    // reachable origin and quietly padded the list while script-src was short
    // the host that actually serves clerk.browser.js.
    for (const host of CLERK_HOSTS.split(" ")) {
      const bare = host.replace(/^https:\/\//, "").replace(/^\*\./, "");
      expect(bare, `${host} must be a resolvable host, not a bare wildcard`).toMatch(
        /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i,
      );
    }
  });

  it("derives a production instance's Frontend API host from the publishable key", () => {
    // Production keys are `pk_live_` + base64("clerk.<domain>$"). A wildcard
    // over Clerk's shared domains can never cover this host, so the SDK's
    // script would be blocked in production if we did not decode it.
    const encoded = Buffer.from("clerk.heimdall.example$").toString("base64");
    expect(clerkFrontendApiHost(`pk_live_${encoded}`)).toBe("clerk.heimdall.example");
    expect(clerkFrontendApiHost(`pk_test_${encoded}`)).toBe("clerk.heimdall.example");
  });

  it("yields no host rather than a malformed source when the key is absent or junk", () => {
    expect(clerkFrontendApiHost(undefined)).toBeNull();
    expect(clerkFrontendApiHost("")).toBeNull();
    expect(clerkFrontendApiHost("not-a-clerk-key")).toBeNull();
    // Decodes, but is not a hostname — must never reach a CSP directive.
    expect(clerkFrontendApiHost(`pk_live_${Buffer.from("' unsafe-inline").toString("base64")}`))
      .toBeNull();
  });

  it("keeps the restrictive baseline that makes the allowances meaningful", async () => {
    const directives = await cspDirectives();

    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'self'"]);
    expect(directives.get("form-action")).toEqual(["'self'"]);
    // R2 is read cross-origin by the frame-chart decode path (§11).
    expect(directives.get("connect-src")).toContain("https://*.r2.cloudflarestorage.com");
  });

  it("ships the rest of the hardening headers", async () => {
    const routes = await nextConfig.headers!();
    const keys = routes.flatMap((route) => route.headers).map((entry) => entry.key);

    expect(keys).toEqual(
      expect.arrayContaining([
        "Referrer-Policy",
        "X-Content-Type-Options",
        "X-Frame-Options",
        "Permissions-Policy",
        "Strict-Transport-Security",
      ]),
    );
  });
});
