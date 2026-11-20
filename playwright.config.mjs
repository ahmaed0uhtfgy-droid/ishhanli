import { defineConfig, devices } from '@playwright/test';
const PORT = Number(process.env.E2E_PORT) || 4173;
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/e2e.json' }]] : [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM, args: JSON.parse(process.env.PW_CHROMIUM_ARGS || '[]') } : {}, // PW_CHROMIUM: مسار كروم جاهز (للبيئات اللي مينفعش تنزّل فيها المتصفح)
     trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'ar-EG' },
  webServer: { command: 'node --no-warnings test/e2e/server.mjs', url: `http://127.0.0.1:${PORT}/__e2e/health`, reuseExistingServer: !process.env.CI, timeout: 30_000, env: { PORT: String(PORT) } },
  projects: [
    // مسار كامل عبر HTTP بدون متصفح (بيشتغل في أي بيئة)
    { name: 'api', testMatch: '**/api-flow.spec.mjs' },
    // اختبارات المتصفح الحقيقي (محتاجة: npx playwright install chromium)
    { name: 'ui', testMatch: ['**/ui.spec.mjs', '**/a11y.spec.mjs', '**/changes.spec.mjs'], use: { ...devices['Desktop Chrome'], locale: 'ar-EG' } },
    { name: 'ui-mobile', testMatch: '**/ui.spec.mjs', use: { ...devices['Pixel 7'], locale: 'ar-EG' } },
  ],
});
