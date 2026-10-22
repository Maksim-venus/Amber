import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The SPA lives in src/web and is served identically to browsers and the Tauri WebView.
// `pnpm dev` (src/tooling/dev.ts) passes the local backend and its one-time token; the
// proxy adds the token so the browser never holds it.
const backend = process.env["AMBER_DEV_BACKEND"];
const token = process.env["AMBER_DEV_TOKEN"];

export default defineConfig({
  root: "src/web",
  // Absolute asset URLs: BrowserRouter serves deep links such as /contents/<id>, and the
  // Tauri asset handler falls back to index.html for them.
  base: "/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    ...(backend === undefined
      ? {}
      : {
          proxy: {
            "/api": {
              target: backend,
              ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
            },
          },
        }),
  },
});
