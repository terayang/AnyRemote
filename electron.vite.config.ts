import { defineConfig } from 'electron-vite'

// Entry defaults follow the electron-vite convention:
// main -> src/main/index.ts, preload -> src/preload/index.ts,
// renderer root -> src/renderer (index.html).
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    esbuild: {
      // React 17+ automatic JSX runtime (no React import needed per file).
      jsx: 'automatic'
    }
  }
})
