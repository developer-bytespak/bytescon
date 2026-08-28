module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react', 'react-hooks', 'jsx-a11y'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
  ],
  settings: { react: { version: 'detect' } },
  rules: {
    // React 17+ JSX transform — no need to import React in scope
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    // React escapes JSX text nodes; this rule only guards against
    // malformed-JSX typos and accounted for ~80 of the ~88 FIX-4
    // burndown errors. Disabled per owner (2026-07-03) instead of
    // churning &apos;/&quot; through 30+ files.
    'react/no-unescaped-entities': 'off',
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    // a11y — Section 508 + WCAG AA baseline
    'jsx-a11y/alt-text': 'error',
    'jsx-a11y/anchor-has-content': 'error',
    'jsx-a11y/aria-role': 'error',
    'jsx-a11y/aria-props': 'error',
    'jsx-a11y/click-events-have-key-events': 'warn',
    'jsx-a11y/no-noninteractive-element-interactions': 'warn',
    'jsx-a11y/no-static-element-interactions': 'warn',
    'jsx-a11y/label-has-associated-control': 'warn',
  },
  ignorePatterns: ['dist', 'node_modules', 'build'],
}
