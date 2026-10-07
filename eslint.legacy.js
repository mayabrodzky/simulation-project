// A deliberately tiny config for src/legacy, run by `npm run lint` alongside
// the main one.
//
// That directory is excluded from the main config because it carries
// a ts-nocheck directive, which makes every type-aware rule report noise rather than
// findings. The cost of that exclusion showed up in production: a call to
// setHtmlById was added without its import, and it threw a ReferenceError the
// first time an emergency fired. TypeScript was silenced, eslint skipped the
// file, and the build succeeded — so nothing in the toolchain was looking.
//
// no-undef alone closes that whole class of mistake, and it needs no type
// information to do it. Removed when the view layer is split into typed
// modules and the main config covers it.
import globals from 'globals';

export default [
  {
    files: ['src/legacy/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
    },
  },
];
