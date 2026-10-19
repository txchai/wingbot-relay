import type { Env as WingbotEnv } from "../src/types";
import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env extends WingbotEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
