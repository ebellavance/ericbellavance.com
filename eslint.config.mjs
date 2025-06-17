import globals from 'globals'
import pluginJs from '@eslint/js'
import tseslint from 'typescript-eslint'

export default [
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      ['no-nested-ternary']: 'error',
      ['no-magic-numbers']: ['error', { ignore: [0], ignoreArrayIndexes: true, ignoreDefaultValues: true }],
      complexity: ['error', { max: 10 }],
      ['max-depth']: ['error', { max: 4 }],
    },
  },
  {
    ignores: ['*.js', 'cdk.out/', 'node_modules/'],
  },
]
