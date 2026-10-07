import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: "build",
  poweredByHeader: false,
};

export default nextConfig;
