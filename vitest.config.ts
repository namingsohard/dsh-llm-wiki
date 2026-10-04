import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    server: {
      deps: {
        // Load the harness packages through Vite rather than Node's external
        // resolution. Two reasons: one module instance for the whole graph
        // (cordis' identity checks are per-instance), and their own bare imports
        // resolve beside them — under an isolated pnpm layout the junction path
        // cannot reach them at all (ERR_MODULE_NOT_FOUND: @deepseek-ai/cosmokit).
        inline: [/@deepseek-ai[\\/]/],
      },
    },
  },
});
