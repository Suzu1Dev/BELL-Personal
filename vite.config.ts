import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The CSP allows fonts only from 'self': font files must stay files, not data: URIs.
  build: { assetsInlineLimit: (file) => (/\.(woff2?|ttf)$/.test(file) ? false : undefined) },
  server: {
    port: 4330,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4331",
      "/oauth": "http://127.0.0.1:4331",
    },
  },
});
