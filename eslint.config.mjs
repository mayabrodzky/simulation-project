// Named .mjs rather than .js because package.json is still the old backend
// manifest and has no "type": "module". It is renamed to eslint.config.js
// later in Phase 1, once package.json becomes the frontend manifest.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/',
      'node_modules/',
      'legacy/',
      // The old Express backend. Not part of the frontend project; it moves
      // into legacy/ later in Phase 1 and is replaced in Phase 3.
      'server.js',
      // The untouched pre-refactor code. It shrinks to nothing over Phase 1,
      // and linting it now would produce hundreds of findings we are not
      // acting on yet.
      'src/legacy/',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser },
    },
    rules: {
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  {
    // Plain JS config files are not part of the TypeScript project, so the
    // type-aware rules cannot run on them. Lint them without type information
    // rather than forcing them into tsconfig.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // The architectural boundary, enforced by the linter rather than by
    // discipline. The simulation engine must be deterministic and headless:
    // the same inputs must always produce the same outputs, and it must be
    // runnable hundreds of times with no browser attached. These directories
    // do not exist yet — the rule is declared first so the first violation is
    // caught the moment the code is written.
    files: ['src/engine/**/*.ts', 'src/scenarios/**/*.ts', 'src/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'The engine must not touch the DOM.' },
        { name: 'document', message: 'The engine must not touch the DOM.' },
        { name: 'localStorage', message: 'The engine must not touch browser storage.' },
        { name: 'performance', message: 'The engine is deterministic: dt is passed in.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use world.rng — runs must be reproducible.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Use world.tickCount / world.nextId — the engine has no clock.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'The engine must be deterministic: pass time in as a parameter.',
        },
      ],
    },
  },

  // Must stay last: switches off stylistic rules that would fight Prettier.
  prettier,
);
