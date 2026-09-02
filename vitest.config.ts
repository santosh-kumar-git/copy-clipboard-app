import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/desktop/main/src/**/*.test.ts',
            'apps/desktop/preload/src/**/*.test.ts',
            'tools/**/*.test.ts',
            // security/source-scan.ts is the shared scanner EVERY source ban runs through, so its
            // own comment-stripping has a plain unit test here. `*.security.test.ts` is excluded
            // below, so this line picks up source-scan.test.ts and nothing else.
            'security/**/*.test.ts',
          ],
          exclude: ['**/node_modules/**', '**/*.security.test.ts'],
        },
      },
      {
        // Renderer component tests. Needs the svelte plugin (for .svelte and .svelte.ts), a DOM, and
        // the `browser` resolve condition — without it Svelte 5 resolves its server build and
        // `mount()` throws `lifecycle_function_unavailable`.
        plugins: [svelte({ configFile: false })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['apps/desktop/renderer/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.security.test.ts'],
        },
      },
      {
        // The security project renders real Svelte components, so it needs the svelte plugin,
        // a DOM, and the `browser` resolve condition. Without that condition Svelte 5 resolves
        // its server build and `mount()` throws `lifecycle_function_unavailable`.
        plugins: [svelte({ configFile: false })],
        resolve: { conditions: ['browser'] },
        test: {
          name: 'security',
          environment: 'jsdom',
          include: [
            'security/**/*.security.test.ts',
            'packages/*/src/**/*.security.test.ts',
            'apps/desktop/*/src/**/*.security.test.ts',
          ],
          exclude: ['**/node_modules/**'],
        },
      },
    ],
  },
})
