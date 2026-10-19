// Vite dev + preview both proxy /api to the server on 127.0.0.1 (D31); no CORS anywhere.
// changeOrigin:false keeps the browser's Host (127.0.0.1:<web port>), which the server's Host guard
// accepts because it is the configured YARVIS_WEB_PORT (D28).
// Host, port (YARVIS_WEB_PORT, default 5173) and strictPort live ONLY here for both dev and preview;
// the web package.json scripts pass no CLI flags, which would override them.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

function port(value: string | undefined, fallback: number): number {
  const n = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`invalid port "${value}"`);
  return n;
}

const apiPort = port(process.env.PORT, 8787);
const webPort = port(process.env.YARVIS_WEB_PORT, 5173);
const proxy = {
  "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@yarvis/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: { host: "127.0.0.1", port: webPort, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: webPort, strictPort: true, proxy },
});
