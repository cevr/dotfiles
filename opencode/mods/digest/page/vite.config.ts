// The digest page's build: Solid's compiler over ui/, one HTML, one JS and one CSS into dist/, which is committed
// and served as static files by the digest plugin (mods/digest/http/listener.ts). `bun run build` here.
import solid from "@solidjs/vite-plugin"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [solid()],
  optimizeDeps: { exclude: ["@ui-sdk/core"] },
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    modulePreload: { polyfill: false },
    rollupOptions: { output: { manualChunks: undefined } },
  },
})
