import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The renderer is plain Vite + React. Electron loads it from the dev server in
// development and from dist/ over the app:// protocol in production, so base
// stays "/" and /brand/... resolves the same way in both.
export default defineConfig({
  plugins: [react()],
  base: "/",
  html: { cspNonce: "arcmail" },
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true, target: "chrome146" },
});
