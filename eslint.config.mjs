import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'node_modules/**', 'build/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // The proxy core must stay a plain Node module so it can run inside a
    // utilityProcess and be unit-tested headlessly.
    files: ['src/proxy/core/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message: 'The proxy core and shared types must not depend on Electron.',
            },
          ],
        },
      ],
    },
  }
);
