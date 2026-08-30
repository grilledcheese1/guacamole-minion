import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Auto-open only for `npm run dev:vite-only`. Under `npm run dev`
    // (`vercel dev`) the app is served from :3000, so opening Vite's own
    // port would land on the wrong URL.
    open: !process.env.VERCEL,
  },
  build: {
    outDir: "dist",
  },
});
