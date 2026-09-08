import { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: '.',
  timeout: 30000,
  workers: 1,
  projects: [
    {
      name: 'Chromium',
      use: {
        browserName: 'chromium',
        channel: 'chromium',
        deviceScaleFactor: 1,
        launchOptions: {
          args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader']
        }
      }
    }
  ],
  reporter: 'list',
  webServer: {
    command: 'pnpm --dir ../../.. start',
    port: 3000,
    timeout: 120000,
    reuseExistingServer: !process.env.CI
  }
};
export default config;
