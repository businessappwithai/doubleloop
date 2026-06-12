/**
 * packages/copilotkit-ui/next.config.js
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
  transpilePackages: ["@dlo/core", "@dlo/adapters-pi"],
  experimental: {
    optimizePackageImports: ["@copilotkit/react-ui", "@copilotkit/react-core"],
  },
};

export default nextConfig;
