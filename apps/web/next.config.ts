import path from "node:path";
import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://img.clerk.com",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  `connect-src 'self' https://*.clerk.accounts https://*.clerk.accounts.dev https://*.clerk.dev https://*.r2.cloudflarestorage.com https://*.r2.dev${isDevelopment ? " ws: wss:" : ""}`,
  "frame-src https://*.clerk.accounts https://*.clerk.accounts.dev https://*.clerk.dev",
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
