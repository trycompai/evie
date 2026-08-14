import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react, { reactCompilerPreset } from "@vitejs/plugin-react"
import babel from "@rolldown/plugin-babel"
import { defineConfig } from "vite"

/** Where `@evie/server` is listening in dev. Overridable; 3001 is the default. */
const apiOrigin = `http://127.0.0.1:${process.env.EVIE_PORT ?? 3001}`

/**
 * Vite 8 (Rolldown) + Oxc, per the roadmap. Both are pre-1.0; the vendored
 * Effect copy and exact pins are what make that an accepted trade rather than
 * a surprise.
 */
export default defineConfig({
  plugins: [
    react(),
    // The React Compiler memoizes for us. It is doing real work in the
    // timeline: without it every row callback is a fresh closure and
    // `TimelineRow`'s memo never hits.
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  optimizeDeps: {
    /*
     * Every @evie/* package is just-in-time: it exports raw .ts/.tsx and emits
     * nothing. Pre-bundling would compile them once and then serve them stale
     * on every edit, which reads as "my change did nothing" rather than as a
     * cache problem. This line and the `@source` in globals.css are the two
     * things a consumer of a JIT package has to know, and neither is
     * discoverable from a stack trace.
     */
    exclude: ["@evie/ui", "@evie/contracts", "@evie/client-runtime", "@evie/shared"],
  },
  server: {
    port: Number(process.env.EVIE_WEB_PORT ?? 3000),
    proxy: {
      /*
       * The server owns auth and blobs; the dev server only owns the bundle.
       * Proxying rather than CORS keeps cookies same-origin in dev, which is
       * the only way the session behaves the way it will in production.
       *
       * The port is read from the environment because a dev machine already
       * running something on 3001 is normal, and the alternative is editing a
       * checked-in file to work around a local conflict.
       */
      "/api": { target: apiOrigin, changeOrigin: true },
      "/blob": { target: apiOrigin, changeOrigin: true },
      /*
       * KNOWN BROKEN on Vite 8.2. This entry is correct by the documented API
       * and the upgrade never arrives: Vite's proxy `upgrade` handler does not
       * fire for `/rpc`, so the app connects to nothing and sits on
       * "connecting" forever with no error in either log.
       *
       * Until that is fixed upstream, the working loop is the one in
       * README.md: build the web bundle and let the server serve it from one
       * origin. The dev server is still right for UI work via the screen
       * gallery, which needs no server at all.
       */
      "/rpc": { target: apiOrigin, ws: true, changeOrigin: true },
    },
  },
  build: {
    // The desktop shell and the packaged server both serve this directory.
    outDir: "dist",
    sourcemap: true,
  },
})
