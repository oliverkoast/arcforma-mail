import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const here = path.dirname(fileURLToPath(import.meta.url));

// The renderer is plain Vite + React. Electron loads it from the dev server in
// development and from dist/ over the app:// protocol in production, so base
// stays "/" and /brand/... resolves the same way in both.
export default defineConfig({
  plugins: [react()],
  base: "/",
  html: { cspNonce: "arcmail" },
  server: { port: 5173, strictPort: true },
  // Two pages: the mail app, and the attachment preview window, which is its
  // own window with its own much smaller policy rather than a panel in the app.
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome146",
    rollupOptions: { input: { index: path.join(here, "index.html"), preview: path.join(here, "preview.html") } },
  },
});
