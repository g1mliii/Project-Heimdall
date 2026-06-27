import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @heimdall/shared ships TypeScript source and @heimdall/ui is resolved to its
  // source via tsconfig paths — both must be transpiled by Next.
  transpilePackages: ["@heimdall/ui", "@heimdall/shared"],
  turbopack: {
    // Pin the workspace root to the monorepo root; otherwise Next can infer a
    // stray lockfile elsewhere on the machine and mis-trace output files.
    root: path.resolve(import.meta.dirname, "..", ".."),
  },
};

export default nextConfig;
