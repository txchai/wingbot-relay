// Local SQLite + WebCrypto fallback, with no sockets or external services.
// Preserve SQL predicates and transactional batches; runtime parity is not claimed.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const sqlite = new DatabaseSync(":memory:");
sqlite.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));

class Statement {
  constructor(query, values = []) { this.query = query; this.values = values; }
  bind(...values) { return new Statement(this.query, values); }
  execute() {
    const result = sqlite.prepare(this.query).run(...this.values);
    return { success: true, results: [], meta: { changes: Number(result.changes) } };
  }
  async run() { return this.execute(); }
  async all() { return { success: true, results: sqlite.prepare(this.query).all(...this.values), meta: {} }; }
  async first(column) {
    const result = sqlite.prepare(this.query).get(...this.values);
    return result === undefined ? null : column ? result[column] : result;
  }
}

const DB = {
  prepare(query) { return new Statement(query); },
  async batch(statements) {
    sqlite.exec("BEGIN");
    try {
      const results = statements.map(statement => statement.execute());
      sqlite.exec("COMMIT");
      return results;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  },
};

const config = readFileSync(new URL("../../wrangler.test.toml", import.meta.url), "utf8");
export const env = {
  DB,
  REGISTRY_JSON: config.match(/REGISTRY_JSON\s*=\s*'''([\s\S]*?)'''/)[1],
  HMAC_PAIR_PERSONAL_WORK: "test-pair-secret-0123456789abcdef",
  WEBHOOK_KEY_PERSONAL_WINGBOT: "test-webhook-key-personal",
  WEBHOOK_KEY_WORK_WINGBOT: "test-webhook-key-work",
  ADMIN_HMAC: "test-admin-secret-0123456789abcdef",
};

// Node requires duplex for stream bodies; Workers does not expose that option.
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input, init) {
    super(input, init?.body instanceof ReadableStream ? { ...init, duplex: "half" } : init);
  }
};
globalThis.fetch = async () => { throw new Error("unmocked fetch forbidden in offline tests"); };

export function createExecutionContext() {
  return { pending: [], waitUntil(promise) { this.pending.push(promise); } };
}
export async function waitOnExecutionContext(ctx) { await Promise.all(ctx.pending); }
export const SELF = { async fetch(input, init) {
  const { handleRequest } = await import("../../src/index.ts");
  return handleRequest(new Request(input, init), env, Math.floor(Date.now() / 1000));
} };
