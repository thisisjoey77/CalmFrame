import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out'] },
  tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    // src/core and src/shared are shared by the app and the validator CLI, so they
    // stay free of Electron and Node. tsconfig.core.json already blocks DOM and Node
    // globals; this blocks the imports.
    files: ['src/core/**/*.ts', 'src/shared/**/*.ts'],
    ignores: ['**/*.test.ts', 'src/core/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['electron', 'electron/*', '@electron-toolkit/*', 'node:*'],
              message: 'src/core and src/shared must be pure TypeScript (see CLAUDE.md).'
            }
          ],
          paths: ['fs', 'path', 'os', 'child_process', 'worker_threads', 'url', 'util'].map(
            (name) => ({
              name,
              message: 'src/core and src/shared must be pure TypeScript (see CLAUDE.md).'
            })
          )
        }
      ]
    }
  },
  {
    // The strobe test page is plain browser JavaScript loaded as a classic script, because
    // the spec requires one static page with no build step and no dependencies. TypeScript
    // annotations cannot appear in it, so the rule that demands them does not apply.
    // Its behaviour is covered by tools/strobe/strobe.test.ts instead.
    files: ['tools/strobe/**/*.js'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  }
)
