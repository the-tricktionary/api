import love from 'eslint-config-love'

const files = [
  'src/*.js',
  'src/*.ts',
  'prisma/*.js',
  'prisma/*.ts',
  '*.mjs'
]

export default [
  {
    ignores: [
      'node_modules/',
      'dist/',
      '.vscode/',
      '**/generated',
      '**/graphql.schema.json',
      '**/local.settings.json',
    ]
  },
  {
    ...love,
    files
  },
  {
    files,
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/strict-boolean-expressions': 'off',
      '@typescript-eslint/restrict-template-expressions': ['warn', {
        allowNumber: true,
        allowBoolean: true,
        allowRegExp: true,
        allowAny: true
      }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      'no-void': 'off',
      'no-console': 'warn'
    }
  }
]
