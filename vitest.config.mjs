import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Every run also writes a machine-readable report, so a failure (a flaky one
// especially) can be read back afterwards without rerunning: `npm run
// test:failures` prints it, and CI uploads the file when the job fails.
export const UNIT_REPORT = 'test-results/vitest/results.json';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/unit/**/*.test.{js,mjs,ts,tsx}'],
    testTimeout: 10000,
    hookTimeout: 10000,
    reporters: [
      'default',
      ['json', { outputFile: UNIT_REPORT }],
      // Inline annotations on the PR for each failing test.
      ...(process.env.GITHUB_ACTIONS ? ['github-actions'] : []),
    ],
  },
});
