import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  use: { channel: process.env.PLAYWRIGHT_CHANNEL, baseURL: 'http://127.0.0.1:18000', viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: 'LULULIAN_DATA_DIR=.data/e2e uv run uvicorn lululian.main:app --app-dir backend --host 127.0.0.1 --port 18000',
    cwd: '..',
    url: 'http://127.0.0.1:18000/api/health',
    reuseExistingServer: false,
  },
})
