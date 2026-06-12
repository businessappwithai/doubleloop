/**
 * packages/copilotkit-ui/next.config.js
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  reactStrictMode: true,
  transpilePackages: ["@dlo/core", "@dlo/adapters-pi"],
  experimental: {
    optimizePackageImports: ["@copilotkit/react-ui", "@copilotkit/react-core"],
  },
};

export default nextConfig;
