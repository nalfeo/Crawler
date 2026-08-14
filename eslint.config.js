import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import inventorybagLaneAccessRule from './tools/eslint-rules/inventorybag-lane-access.js';
import noRethrowInAutomationCatchRule from './tools/eslint-rules/no-rethrow-in-automation-catch.js';

const layerImportPatterns = (layer) => [
  layer,
  `${layer}/**`,
  `src/${layer}`,
  `src/${layer}/**`,
  `**/${layer}`,
  `**/${layer}/**`,
];

const crawlerLocalPlugin = {
  rules: {
    'no-direct-inventorybag-lane-read': inventorybagLaneAccessRule,
    'no-rethrow-in-automation-catch': noRethrowInAutomationCatchRule,
  },
};

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
    files: ['.github/scripts/*.mjs', '.github/scripts/**/*.mjs', 'scripts/agent/perf/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...(globals.node ?? {}),
      },
    },
    rules: {
      'no-undef': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-regex-spaces': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
  {
    // Visual-review setup scripts are injected into the Playwright page context.
    files: ['scripts/agent/review/setup/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...(globals.browser ?? {}),
        ...(globals.node ?? {}),
      },
    },
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    ignores: [
      'src/shared/inventory.ts',
      // Intentional corruption fixture for defensive-path testing.
      'tests/ecs/equipment.test.ts',
    ],
    plugins: {
      crawler: crawlerLocalPlugin,
    },
    rules: {
      'crawler/no-direct-inventorybag-lane-read': 'error',
    },
  },
  {
    // Class B (automation liveness): a re-thrown error in the merge-train or
    // CI-recovery loops propagates to the top level, kills the Node process
    // mid-run, and leaves the queue with nobody to unstick it — exactly how a
    // re-thrown non-422 update-branch error deadlocked the merge queue for
    // ~90 minutes. These loops must log and skip, never throw.
    files: ['.github/scripts/merge-train/**/*.mjs', '.github/scripts/ci-recovery/**/*.mjs'],
    ignores: ['**/*.test.mjs'],
    plugins: {
      crawler: crawlerLocalPlugin,
    },
    rules: {
      'crawler/no-rethrow-in-automation-catch': 'error',
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
  {
    // ADR 0044 / Size-Weight Slice 1: sprite.width / sprite.height are render
    // concerns only. Physics (collision, knockback, radius, footprint) must
    // read through `getBodyHalfWidth/Height/Radius` in `src/core/physics-body.ts`
    // so a Size regression cannot silently reintroduce sprite-based bodies.
    // Engine (renderer) and labs (dev sandboxes) are exempt.
    files: ['src/core/**/*.ts', 'src/game/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    ignores: [
      'src/core/physics-body.ts',
      // Test fixtures that legitimately write / assert sprite dims for
      // spawner correctness or set up legacy scenarios pre-migration:
      'tests/ecs/knockback-system.test.ts',
      'tests/**/collision-*.test.ts',
      'tests/ecs/spawners/**/*.test.ts',
      'tests/ecs/drop-system.test.ts',
      'tests/game/ability-system.test.ts',
      'tests/ecs/equipment.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        // Dot notation: something.sprite.width / .height
        {
          selector:
            "MemberExpression[object.type='MemberExpression'][object.property.name='sprite'][property.name=/^(width|height)$/]",
          message:
            'Do not read sprite.width/height for physics. Use getBodyHalfWidth/Height/Radius from src/core/physics-body.ts (ADR 0044). Renderer code lives in src/engine/**.',
        },
        // Computed notation: something.sprite['width'] / ['height']
        {
          selector:
            "MemberExpression[computed=true][object.type='MemberExpression'][object.property.name='sprite'][property.value=/^(width|height)$/]",
          message:
            'Do not read sprite.width/height for physics. Use getBodyHalfWidth/Height/Radius from src/core/physics-body.ts (ADR 0044). Renderer code lives in src/engine/**.',
        },
      ],
    },
  },
);
