import path from "node:path";
import type { NextConfig } from "next";

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
};

export default nextConfig;
