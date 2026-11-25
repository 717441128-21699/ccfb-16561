/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.bench.ts'],
    testTimeout: 120_000,
  },
});
