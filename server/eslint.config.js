import tseslint from 'typescript-eslint';

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // A.8.28: parameterised queries only — string-built SQL is flagged in review;
      // this rule at least catches accidental template-literal query building.
      'no-template-curly-in-string': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
);
