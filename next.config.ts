import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright's boot smoke spec (e2e/boot.spec.ts) drives the dev server
  // over 127.0.0.1; without this the HMR websocket's cross-origin guard
  // logs a warning on every request.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
