import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SETUP_TOKEN: 'test-setup',
          // Existing tests open many pages per station; the intake tests pass their own limits.
          MAX_LIVE_PAGES: '1000',
          MAX_NEW_PAGES_PER_MINUTE: '1000',
          MAX_PAGES_PER_SHIFT: '10000',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
