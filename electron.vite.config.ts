import { resolve } from 'path'
import { defineConfig } from 'electron-vite'

// Renderer root is src/ so each window keeps its own folder from the spec layout:
// src/overlay/index.html and src/dashboard/index.html, plus the debug window in
// src/debug/index.html (CALMFRAME_DEBUG_WINDOW=1). In dev they are served at
// `${ELECTRON_RENDERER_URL}/<page>/index.html`; in production they build to
// out/renderer/<page>/index.html.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, 'src'),
    build: {
      rolldownOptions: {
        input: {
          overlay: resolve(__dirname, 'src/overlay/index.html'),
          dashboard: resolve(__dirname, 'src/dashboard/index.html'),
          debug: resolve(__dirname, 'src/debug/index.html')
        }
      }
    }
  }
})
