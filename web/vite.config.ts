import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// `@` → web/src, matching the shadcn import convention (@/components, @/lib).
const alias = { "@": resolve(here, "src") };

// The frontend is inlined into a single index.html (viteSingleFile) so the server
// only ever serves one tokened URL — no separate asset requests that would need
// their own auth. Output goes to dist/web, which `dom serve` serves.
export default defineConfig({
  root: here,
  resolve: { alias },
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(here, "../dist/web"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4096,
  },
});
