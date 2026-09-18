import neostandard, { resolveIgnoresFromGitignore } from 'neostandard'
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  {
    ignores: [
      ...resolveIgnoresFromGitignore(),
      'src/generated/',
      'graphql.schema.json'
    ]
  },
  ...neostandard({
    files: [
      '**/*.js',
      '**/*.mjs',
      '**/*.cjs'
    ],
    filesTs: [
      '**/*.ts',
      '**/*.mts',
      '**/*.cts'
    ],
    ts: true
  }),
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['*.mjs', '*.js']
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
  {
    name: 'migrate/eslint-config-standard-with-typescript',
    rules: {
      '@typescript-eslint/array-type': ['error', { default: 'array-simple' }],
      '@typescript-eslint/consistent-type-exports': [
        'error',
        {
          fixMixedExportsWithInlineTypeSpecifier: true
        }
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@stylistic/member-delimiter-style': [
        'error',
        {
          multiline: { delimiter: 'none' },
          singleline: { delimiter: 'comma', requireLast: false }
        }
      ],
      '@typescript-eslint/method-signature-style': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/return-await': ['error', 'always'],
      '@typescript-eslint/triple-slash-reference': ['error', { lib: 'never', path: 'never', types: 'never' }],
      '@stylistic/type-annotation-spacing': 'error',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off'
    }
  },
  {
    rules: {
      'no-void': ['error', { allowAsStatement: true }],
      '@typescript-eslint/restrict-template-expressions': ['warn', {
        // It'll be the literal number
        allowNumber: true,
        // It'll be the literal boolean
        allowBoolean: true,
        // It'll be the regexp source (`${/a/g}` => '/a/g')
        allowRegExp: true,
        // If you YOLO, you YOLO
        allowAny: true
      }],
      '@typescript-eslint/no-empty-function': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'warn'
    }
  }
]
