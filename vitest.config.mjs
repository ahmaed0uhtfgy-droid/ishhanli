import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: [{ find: /^(.*)\/js\/firebase-key\.js$|^\.\/firebase-key\.js$/, replacement: fileURLToPath(new URL('./test/helpers/firebase-key.stub.mjs', import.meta.url)) }] }, // المفتاح بيتقدّم من Pages Function وقت التشغيل؛ في الاختبار بنستبدله بملف وهمي
  test: {
    include: ['test/unit/**/*.spec.mjs', 'test/integration/**/*.spec.mjs'],
    environment: 'node',
    testTimeout: 20000,
    coverage: { provider: 'v8', include: ['functions/_lib/**', 'public/js/**'], reporter: ['text-summary', 'json-summary'] },
  },
});
