import { defineConfig } from '@playwright/test';

const baseURL = 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL,
    reducedMotion: 'reduce',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: 'yarn start',
    env: {
      // Bind and resolve localhost consistently in containers.
      NODE_OPTIONS: [process.env.NODE_OPTIONS, '--dns-result-order=ipv4first']
        .filter(Boolean)
        .join(' '),
    },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
