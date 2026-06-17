import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const layerImportPatterns = (layer) => [
  layer,
  `${layer}/**`,
  `src/${layer}`,
  `src/${layer}/**`,
  `**/${layer}`,
  `**/${layer}/**`,
];

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src/engine/sprites/*.js',
      'src/devtools/*.js',
      'src/devtools/*.d.ts',
      'scripts/sprites/**/*.js',
      'scripts/sprites/**/*.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...(globals.browser ?? {}),
        ...(globals.node ?? {}),
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    languageOptions: {
      globals: {
        ...(globals.browser ?? {}),
        ...(globals.node ?? {}),
        ...(globals.vitest ?? {}),
      },
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: layerImportPatterns('engine'),
              message: 'Core code cannot import engine modules.',
            },
            {
              group: layerImportPatterns('game'),
              message: 'Core code cannot import game modules.',
            },
            {
              group: layerImportPatterns('labs'),
              message: 'Core code cannot import lab modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/engine/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: layerImportPatterns('game'),
              message: 'Engine code cannot import game modules.',
            },
            {
              group: layerImportPatterns('labs'),
              message: 'Engine code cannot import lab modules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/game/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: layerImportPatterns('engine'),
              message: 'Game code cannot import engine modules.',
            },
            {
              group: layerImportPatterns('labs'),
              message: 'Game code cannot import lab modules.',
            },
          ],
        },
      ],
    },
  },
);
