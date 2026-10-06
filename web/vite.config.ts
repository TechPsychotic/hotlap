import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During dev the Rust core runs on :8080; proxy the API + WebSocket to it so the
// web app talks to the same endpoints it will use in production (served by core).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/ws": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
  build: {
    outDir: "dist",
    // Keep asset names stable-ish; the core embeds whatever is here.
    emptyOutDir: true,
  },
});
