import { defineConfig } from '@playwright/test';

/**
 * E2E smoke tests run against the already-running dev stack (`pnpm infra:up && pnpm dev`).
 * They skip themselves when MediaMTX is not reachable so `pnpm test` stays green on CI without Docker.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5174',
    headless: true,
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  reporter: [['list']],
});
