import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// dev: `bun run dev` → proxy /v1 ke API lokal (satu origin → cookie refresh bekerja tanpa CORS)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy: { "/v1": process.env.SMIP_API_URL ?? "http://127.0.0.1:8080" } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 1500 },
});
