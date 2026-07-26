import path from "node:path";
import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";

/**
 * A Clerk publishable key encodes its instance's Frontend API host: everything
 * after the `pk_test_`/`pk_live_` prefix is that host, base64'd, with a `$`
 * terminator. Decoding it is the only way to name a *production* instance's
 * host, which is a CNAME on the app's own domain (`clerk.example.com`) and
 * matches none of Clerk's shared wildcards.
 */
export function clerkFrontendApiHost(publishableKey: string | undefined): string | null {
  // Matched rather than stripped: `replace` returns the input unchanged on a
  // miss, so the old prefix check leaned on an equality sentinel to spot it.
  const encoded = publishableKey?.match(/^pk_(?:test|live)_(.+)$/)?.[1];
  if (!encoded) return null;
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    // Reject anything that is not a bare hostname before it reaches a policy.
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Clerk's frontend API hosts. `@clerk/nextjs` loads `clerk.browser.js` from the
 * instance's own host at runtime, so these belong in `script-src` as well as
 * `connect-src`/`frame-src` — without the script grant the SDK never boots and
 * every auth surface silently fails to hydrate (§20).
 *
 * `*.clerk.accounts.dev` covers development instances. Production instances are
 * served from the deployment's own domain, so that host is derived from the
 * publishable key rather than guessed at with a wildcard.
 */
const clerkInstanceHost = clerkFrontendApiHost(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

export const CLERK_HOSTS = [
  "https://*.clerk.accounts.dev",
  ...(clerkInstanceHost ? [`https://${clerkInstanceHost}`] : []),
].join(" ");

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' ${CLERK_HOSTS}${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' ${CLERK_HOSTS} https://*.r2.cloudflarestorage.com https://*.r2.dev${isDevelopment ? " ws: wss:" : ""}`,
  `frame-src ${CLERK_HOSTS}`,
  "upgrade-insecure-requests",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  // @heimdall/shared and @heimdall/parsers ship TypeScript source and
  // @heimdall/ui is resolved to its source via tsconfig paths — all must be
  // transpiled by Next.
  transpilePackages: ["@heimdall/ui", "@heimdall/shared", "@heimdall/parsers"],
  turbopack: {
    // Pin the workspace root to the monorepo root; otherwise Next can infer a
    // stray lockfile elsewhere on the machine and mis-trace output files.
    root: path.resolve(import.meta.dirname, "..", ".."),
  },
  // The dev-tools floating button photobombs Playwright visual baselines
  // (e2e runs against `next dev` locally); production builds never show it.
  devIndicators: false,
  // §8.5.6: protect page and API responses at the application boundary. The
  // deployment must still lock its origin before trusting a proxy IP header.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
