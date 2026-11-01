/// <reference types="vite/client" />

// Lets plain TypeScript tooling (the type-aware linter) import single-file components. vue-tsc,
// which runs the type check, reads the real components instead.
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
