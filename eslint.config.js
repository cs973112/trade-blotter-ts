import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

export default defineConfig(
  {
    ignores: ['**/node_modules/', '**/dist/', '**/coverage/'],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  // Vue single-file components: Vue's recommended rules, and TypeScript rules that need no type
  // information (typescript-eslint cannot read types from .vue files; vue-tsc type-checks them).
  pluginVue.configs['flat/recommended'],
  // Like the TypeScript code, templates are not held to formatting rules.
  pluginVue.configs['no-layout-rules'],
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
    extends: [tseslint.configs.disableTypeChecked],
    // vue-tsc reports undefined names, including DOM types such as HTMLElement.
    rules: { 'no-undef': 'off' },
  },
  // The client talks to the server only over HTTP: no server code, Node built-ins or server libraries.
  {
    files: ['client/src/**/*.ts', 'client/src/**/*.vue'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?:node:|fastify|@fastify/|drizzle-orm|drizzle-kit|decimal\\.js$|@trade-blotter/server)|(?:^|/)server/',
          message: 'The client reaches the server only through its HTTP API.',
        }],
      }],
    },
  },
  // Layer boundaries (docs/architecture.md, "Layers"). Each layer lists what it may import.
  {
    files: ['server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?!\\./|decimal\\.js$)',
          message: 'The domain is pure: it may import only other domain modules and decimal.js.',
        }],
      }],
    },
  },
  {
    files: ['server/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?!\\./|\\.\\./domain/)',
          message: 'The application may import only application and domain modules; frameworks and databases stay outside.',
        }],
      }],
    },
  },
  {
    files: ['server/src/infrastructure/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?:fastify|@fastify/.*|vue|@vue/.*|pinia)$|(?:^|/)api/',
          message: 'Infrastructure implements application interfaces; it must not depend on the HTTP layer or the UI.',
        }],
      }],
    },
  },
  {
    files: ['server/src/api/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          regex: '^(?:drizzle-orm|drizzle-kit|node:sqlite)(?:/|$)|(?:^|/)infrastructure/',
          message: 'The API reaches persistence only through application services; it must not import Drizzle, SQLite or infrastructure.',
        }],
      }],
    },
  },
)
