import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/", // Change to repo name if deploying to GitHub Pages subdirectory
  build: {
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 3000,
  },
});
