import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // ESLint runs as an explicit workspace check with the shared flat config.
  eslint: { ignoreDuringBuilds: true },
  transpilePackages: ["@koven/domain", "@koven/schemas"],
  webpack(webpackConfig) {
    // Workspace packages use NodeNext-style `.js` specifiers in TypeScript.
    // Resolve those specifiers to source files while Next bundles the monorepo.
    webpackConfig.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return webpackConfig;
  },
};

export default config;
