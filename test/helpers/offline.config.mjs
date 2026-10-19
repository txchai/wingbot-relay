// Supplemental in-process checks when the Cloudflare pool cannot bind localhost.
// This does not replace verification against the Workers runtime and real D1.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:test": fileURLToPath(new URL("./offline-cloudflare.mjs", import.meta.url)) } },
  test: {
    include: ["test/*.test.ts"],
    setupFiles: ["./test/helpers/offline-cloudflare.mjs"],
  },
});
