import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Transpile workspace packages so they work without pre-compiling.
  transpilePackages: [
    '@seaking/api',
    '@seaking/auth',
    '@seaking/db',
    '@seaking/money',
    '@seaking/dates',
    '@seaking/ui',
    '@seaking/validators',
    '@seaking/notifications',
  ],
  experimental: {
    // serverActions are enabled by default in Next 15; no config needed.
  },
};

export default config;
