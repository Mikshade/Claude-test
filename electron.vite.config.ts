import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

// Three bundles: main (Node/Electron), preload (sandboxed bridge), renderer (two pages).
// Dependencies are externalized by default in electron-vite 5 (build.externalizeDeps), so no plugin is needed;
// the preload only imports 'electron' and bundled @shared sources, which is what a sandboxed preload allows.
export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  preload: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
    // `src/renderer/public` is copied verbatim into out/renderer (Cubism Core lives there).
    publicDir: resolve(__dirname, 'src/renderer/public'),
    build: {
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
        },
      },
    },
  },
})
