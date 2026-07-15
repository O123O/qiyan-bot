import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Build the whole client into ONE self-contained ../assets/webui/index.html (JS+CSS inlined), so
// the bot ships a single committed asset and the packaging/pack-tests stay unchanged.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "../assets/webui", emptyOutDir: true, assetsInlineLimit: 100000000, chunkSizeWarningLimit: 4000 },
});
