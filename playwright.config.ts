import { defineConfig } from '@playwright/test';
import {
  workspaceUrl,
  workspaceBackendUrl,
  usesIsolatedPorts,
} from './e2e/workspaceUrls';

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: workspaceUrl,
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
      ...(usesIsolatedPorts && {
        APP_CONFIG_app_baseUrl: workspaceUrl,
        APP_CONFIG_backend_baseUrl: workspaceBackendUrl,
        APP_CONFIG_backend_listen_port: new URL(workspaceBackendUrl).port,
        APP_CONFIG_backend_cors_origin: workspaceUrl,
      }),
    },
    url: workspaceUrl,
    reuseExistingServer: !process.env.CI && !usesIsolatedPorts,
    timeout: 120_000,
  },
});
