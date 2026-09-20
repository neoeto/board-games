import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ISOLATION_HEADERS = Object.freeze({
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "cross-origin-isolated=(self)",
});

export default defineConfig({
  plugins: [react()],
  server: {
    headers: ISOLATION_HEADERS,
  },
  preview: {
    headers: ISOLATION_HEADERS,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
