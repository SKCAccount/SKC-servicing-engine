import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
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
};

export default config;
