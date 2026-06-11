import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.{js,mjs,ts}'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
