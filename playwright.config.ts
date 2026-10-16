import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

export default defineConfig({
  timeout: 120_000,
  projects: [
    { name: 'e2e', testDir: 'tests/e2e' },
    // Review screenshots (npm run shots), not run in CI.
    { name: 'shots', testDir: 'tests/shots', timeout: 240_000 },
  ],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ...devices['Pixel 7'],
    // Cloud dev containers ship a pre-installed Chromium; CI downloads its own.
    launchOptions: {
      ...(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}),
      // Several pages play as separate "phones": don't let Chromium throttle the ones behind.
      args: ['--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'],
    },
  },
  webServer: [
    {
      command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
      port: PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Stand-in for phones' Wi-Fi so two browser pages can play each other.
      command: 'npx tsx scripts/lan-dev-server.ts',
      port: 8787,
      reuseExistingServer: !process.env.CI,
    },
  ],
});
