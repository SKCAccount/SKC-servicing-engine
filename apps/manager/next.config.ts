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
    '@seaking/retailer-parsers',
    '@seaking/domain',
  ],
  experimental: {
    // PO and invoice CSV uploads hit ~1-2 MB routinely. Bump the default
    // Server Action body-size limit from 1 MB. 50 MB matches the Storage
    // bucket file size limit (migration 0015) so anything Storage accepts
    // also fits through the action layer.
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default config;
