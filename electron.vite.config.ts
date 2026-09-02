import { builtinModules } from 'node:module'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'electron-vite'

// Everything NOT in this list is bundled — which is exactly how `@cairn/*` TypeScript source
// reaches the main process with no build step. `electron` and `sharp` must stay external:
// one is injected by the runtime, the other is a Node-API .node binary.
const NODE_EXTERNALS = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
  'electron',
  'sharp',
]

export default defineConfig({
  main: {
    build: {
      outDir: 'apps/desktop/out/main',
      lib: { entry: 'apps/desktop/main/src/index.ts', formats: ['cjs'] },
      rollupOptions: { external: NODE_EXTERNALS, output: { entryFileNames: 'index.js' } },
      minify: false,
      sourcemap: false,
    },
  },
  preload: {
    build: {
      outDir: 'apps/desktop/out/preload',
      lib: { entry: 'apps/desktop/preload/src/index.ts', formats: ['cjs'] },
      rollupOptions: { external: NODE_EXTERNALS, output: { entryFileNames: 'index.js' } },
      minify: false,
      sourcemap: false,
    },
  },
  renderer: {
    root: 'apps/desktop/renderer',
    plugins: [svelte()],
    build: {
      outDir: 'apps/desktop/out/renderer',
      rollupOptions: { input: 'apps/desktop/renderer/index.html' },
    },
  },
})
