import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          d1Databases: ["DB"],
          bindings: {
            TEST_MIGRATIONS: migrations,
            HMAC_PAIR_PERSONAL_WORK: "test-pair-secret-0123456789abcdef",
            WEBHOOK_KEY_PERSONAL_WINGBOT: "test-webhook-key-personal",
            WEBHOOK_KEY_WORK_WINGBOT: "test-webhook-key-work",
            ADMIN_HMAC: "test-admin-secret-0123456789abcdef",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
