import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './quals',
  testMatch: '**/*.qual.js',
  timeout: 20000,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1500, height: 1000 },
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
  },
})
