import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest, runSweep } from "../src/index";
import { makeStore } from "../src/store/d1";
import type { BotId, Envelope, Env, MessageRow, Registry } from "../src/types";
import { signRequest } from "../cli/wingbot-send.mjs";
import { signRequest as signWithWebCrypto } from "./helpers/signing";
import { observeD1 } from "./helpers/d1";
import signingVectors from "./fixtures/signing-vectors.json";

const NOW = 1_800_000_000;
const PERSONAL: BotId = "personal:wingbot";
const WORK: BotId = "work:wingbot";
const registry = JSON.parse(env.REGISTRY_JSON) as Registry;

interface WebhookCall {
  method: string;
  headers: Headers;
  body: { wingbot: number; envelope: Envelope; relay: { received_at: number; attempt: number; verified: boolean } };
  redirect: RequestInit["redirect"];
}

interface MockWebhook {
  calls: WebhookCall[];
  respond: () => Response | Promise<Response>;
}

let webhooks: Map<string, MockWebhook>;
let unexpectedUrls: string[];
const webhook = (id: BotId) => webhooks.get(registry.bots.find(bot => bot.id === id)!.webhook_url)!;

function envelope(change: Partial<Envelope> = {}): Envelope {
  return {
    v: 1, id: crypto.randomUUID(), kind: "task", from: PERSONAL, to: WORK,
    task: "Report the task outcome", context: { project: "acceptance" }, reply_to: null, ts: NOW,
    ...change,
  };
}

async function signed(body: unknown, bot: string, ts: number, path = "/v1/messages", secret = String(env.HMAC_PAIR_PERSONAL_WORK)) {
  const raw = JSON.stringify(body);
  return new Request(`https://wingbot.test${path}`, {
    method: "POST", body: raw, headers: signRequest({ secret, bot, body: raw, ts, path }),
  });
}

async function send(message: Envelope, now = NOW, bindings: Env = env) {
  return handleRequest(await signed(message, message.from, message.ts), bindings, now);
}

async function admin(action: "pause" | "resume", bot: BotId | null, now = NOW) {
  return handleRequest(await signed({ bot }, "admin", now, `/v1/admin/${action}`, String(env.ADMIN_HMAC)), env, now);
}

// Exercise cron's waitUntil lifecycle while keeping its clock explicit.
async function sweepAt(now: number, bindings: Env = env) {
  const ctx = createExecutionContext();
  ctx.waitUntil(runSweep(bindings, now));
  await waitOnExecutionContext(ctx);
}

const messageRow = (id: string) => env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
const attempts = async (id: string) => (await env.DB.prepare(
  "SELECT attempt, http_status, error FROM attempts WHERE message_id = ? ORDER BY id",
).bind(id).all<{ attempt: number; http_status: number | null; error: string | null }>()).results;

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toContain("application/json");
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual(body);
}

beforeEach(async () => {
  await env.DB.batch(["attempts", "messages", "audit", "settings", "rate_limits"].map(table =>
    env.DB.prepare(`DELETE FROM ${table}`),
  ));
  webhooks = new Map(registry.bots.map(bot => [bot.webhook_url, { calls: [], respond: () => new Response(null, { status: 200 }) }]));
  unexpectedUrls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = webhooks.get(url);
    if (!target) {
      unexpectedUrls.push(url);
      throw new Error("unexpected outbound URL");
    }
    const request = new Request(input, init);
    target.calls.push({ method: request.method, headers: request.headers, body: await request.json(), redirect: init?.redirect });
    return target.respond();
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedUrls).toEqual([]);
});

describe("acceptance: signed delivery", () => {
  it.each(signingVectors)("matches the Node CLI signing vector for $path", async vector => {
    expect(signRequest(vector)["X-Wingbot-Signature"]).toBe(vector.signature);
    expect((await signWithWebCrypto(vector))["X-Wingbot-Signature"]).toBe(vector.signature);
  });

  it("delivers a personal-to-work task and its result reply with the correct credentials and payloads", async () => {
    const task = envelope({ task: "Check café status ☕", context: { request: 42 } });
    await expectJson(await send(task), 202, { id: task.id, status: "delivered" });
    const reply = envelope({ from: WORK, to: PERSONAL, kind: "result", reply_to: task.id, task: "Done", ts: NOW + 1 });
    await expectJson(await send(reply, NOW + 1), 202, { id: reply.id, status: "delivered" });

    for (const [id, message, keyName, receivedAt] of [
      [WORK, task, "WEBHOOK_KEY_WORK_WINGBOT", NOW],
      [PERSONAL, reply, "WEBHOOK_KEY_PERSONAL_WINGBOT", NOW + 1],
    ] as const) {
      expect(webhook(id).calls).toHaveLength(1);
      const call = webhook(id).calls[0];
      expect(call.method).toBe("POST");
      expect(call.headers.get("Authorization")).toBe(`Bearer ${env[keyName]}`);
      expect(call.headers.get("X-Automation-Key")).toBe(env[keyName]);
      expect(call.headers.get("Content-Type")).toBe("application/json");
      expect(call.redirect).toBe("manual");
      expect(call.body).toEqual({ wingbot: 1, envelope: message, relay: { received_at: receivedAt, attempt: 1, verified: true } });
      expect(await messageRow(message.id)).toMatchObject({ status: "delivered", attempts: 1, next_attempt_at: null, last_status_code: 200 });
      expect(await attempts(message.id)).toEqual([{ attempt: 1, http_status: 200, error: null }]);
    }
    expect(await messageRow(reply.id)).toMatchObject({ kind: "result", reply_to: task.id });
  });

  it("rejects a bad signature with a generic 401, writes nothing and sends nothing", async () => {
    const task = envelope();
    const request = await signed(task, PERSONAL, NOW);
    request.headers.set("X-Wingbot-Signature", `v1=${"0".repeat(64)}`);
    await expectJson(await handleRequest(request, env, NOW), 401, { error: "unauthorized" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(webhook(PERSONAL).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toBeNull();
    expect((await env.DB.prepare("SELECT event, detail, message_id FROM audit").all()).results).toEqual([]);
  });

  it("rejects the same id with a valid fresh signature as a duplicate and delivers only once", async () => {
    const task = envelope();
    await expectJson(await send(task), 202, { id: task.id, status: "delivered" });
    await expectJson(await send({ ...task, ts: NOW + 10 }, NOW + 10), 409, { error: "duplicate" });
    expect(webhook(WORK).calls).toHaveLength(1);
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await attempts(task.id)).toHaveLength(1);
  });

  it("rejects a correctly signed timestamp at now minus 301 seconds", async () => {
    const task = envelope({ ts: NOW - 301 });
    await expectJson(await send(task), 401, { error: "unauthorized" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toBeNull();
  });

  it.each([
    ["unknown sender", { from: "unknown:bot" }],
    ["unknown recipient", { to: "unknown:bot" }],
    ["disallowed self-pair", { to: PERSONAL }],
  ] as const)("rejects an %s with the same generic 401", async (_label, change) => {
    const task = envelope(change);
    await expectJson(await send(task), 401, { error: "unauthorized" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(webhook(PERSONAL).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toBeNull();
  });

  it("rejects two known bots without an enabled pair", async () => {
    const bindings = { ...env, REGISTRY_JSON: JSON.stringify({ ...registry, pairs: [] }) };
    await expectJson(await send(envelope(), NOW, bindings), 401, { error: "unauthorized" });
    expect(webhook(WORK).calls).toHaveLength(0);
  });

  it.each([
    ["POST", "/unknown"], ["GET", "/v1/messages"], ["GET", "/v1/admin/pause"],
  ])("returns a generic 404 for %s %s", async (method, path) => {
    await expectJson(await handleRequest(new Request(`https://wingbot.test${path}`, { method }), env, NOW), 404, { error: "not_found" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(webhook(PERSONAL).calls).toHaveLength(0);
  });

  it("returns a generic 400 for a signed invalid envelope", async () => {
    const task = envelope({ kind: "result", reply_to: null });
    await expectJson(await send(task), 400, { error: "bad_request" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toBeNull();
  });

  it("enforces the sending bot's fixed-window rate limit before inserting or forwarding", async () => {
    const bindings = { ...env, REGISTRY_JSON: JSON.stringify({ ...registry, bots: registry.bots.map(bot => ({ ...bot, rate_limit_per_min: 2 })) }) };
    for (let i = 0; i < 2; i++) {
      const task = envelope();
      await expectJson(await send(task, NOW, bindings), 202, { id: task.id, status: "delivered" });
    }
    const blocked = envelope();
    await expectJson(await send(blocked, NOW, bindings), 429, { error: "rate_limited" });
    expect(await messageRow(blocked.id)).toBeNull();
    expect(webhook(WORK).calls).toHaveLength(2);
    const nextWindow = envelope({ ts: NOW + 60 });
    await expectJson(await send(nextWindow, NOW + 60, bindings), 202, { id: nextWindow.id, status: "delivered" });
    expect(webhook(WORK).calls).toHaveLength(3);
  });
});

describe("acceptance: retries and kill switches", () => {
  it.each([[200, "delivered"], [500, "failed"]] as const)("ends 500, 500, %i as %s after exactly three attempts", async (lastStatus, finalStatus) => {
    const outcomes = [500, 500, lastStatus];
    webhook(WORK).respond = () => new Response(null, { status: outcomes.shift() ?? 599 });
    const task = envelope();
    await expectJson(await send(task), 202, { id: task.id, status: "queued" });
    expect(await messageRow(task.id)).toMatchObject({ status: "queued", attempts: 1, next_attempt_at: NOW + 60 });
    await sweepAt(NOW + 59);
    expect(webhook(WORK).calls).toHaveLength(1);
    await sweepAt(NOW + 60);
    expect(await messageRow(task.id)).toMatchObject({ status: "queued", attempts: 2, next_attempt_at: NOW + 180 });
    await sweepAt(NOW + 179);
    expect(webhook(WORK).calls).toHaveLength(2);
    await sweepAt(NOW + 180);
    expect(await messageRow(task.id)).toMatchObject({ status: finalStatus, attempts: 3, next_attempt_at: null, last_status_code: lastStatus });
    expect(await attempts(task.id)).toEqual([
      { attempt: 1, http_status: 500, error: "http_error" },
      { attempt: 2, http_status: 500, error: "http_error" },
      { attempt: 3, http_status: lastStatus, error: lastStatus === 200 ? null : "http_error" },
    ]);
    expect(webhook(WORK).calls.map(call => call.body)).toEqual([1, 2, 3].map(attempt => ({
      wingbot: 1, envelope: task, relay: { received_at: NOW, attempt, verified: true },
    })));
    await sweepAt(NOW + 360);
    expect(webhook(WORK).calls).toHaveLength(3);
    expect(await attempts(task.id)).toHaveLength(3);
  });

  it.each([["global", null], ["target bot", WORK]] as const)("queues without attempts under the %s kill switch and delivers immediately after resume", async (_scope, bot) => {
    await expectJson(await admin("pause", bot), 200, { key: bot ? `paused:${bot}` : "paused", value: "1" });
    const task = envelope();
    await expectJson(await send(task), 202, { id: task.id, status: "queued" });
    expect(await messageRow(task.id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: NOW });
    await sweepAt(NOW);
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(await attempts(task.id)).toEqual([]);
    expect(await makeStore(env.DB).dueForRetry(NOW, 20)).toEqual([]);
    await expectJson(await admin("resume", bot, NOW + 1), 200, { key: bot ? `paused:${bot}` : "paused", value: "0" });
    await sweepAt(NOW + 1);
    expect(webhook(WORK).calls).toHaveLength(1);
    expect(webhook(WORK).calls[0].body.relay).toEqual({ received_at: NOW, attempt: 1, verified: true });
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("keeps an unrelated target available during a per-bot pause", async () => {
    await admin("pause", WORK);
    const task = envelope({ from: WORK, to: PERSONAL });
    await expectJson(await send(task), 202, { id: task.id, status: "delivered" });
    expect(webhook(PERSONAL).calls).toHaveLength(1);
    expect(webhook(WORK).calls).toHaveLength(0);
  });

  it("does not let a pair HMAC authorize an admin action", async () => {
    const request = await signed({ bot: null }, "admin", NOW, "/v1/admin/pause");
    await expectJson(await handleRequest(request, env, NOW), 401, { error: "unauthorized" });
    expect((await env.DB.prepare("SELECT * FROM settings").all()).results).toEqual([]);
  });

  it("processes at most seven eligible queued messages per sweep", async () => {
    await admin("pause", null);
    for (let i = 0; i < 11; i++) await send(envelope());
    await admin("resume", null);
    await sweepAt(NOW);
    expect(webhook(WORK).calls).toHaveLength(7);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'queued'").first()).toEqual({ n: 4 });
    await sweepAt(NOW + 60);
    expect(webhook(WORK).calls).toHaveLength(11);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'delivered'").first()).toEqual({ n: 11 });
  });
});

describe("acceptance: secret hygiene", () => {
  it("keeps secrets and Authorization values out of console output and every D1 metadata table", async () => {
    const output: string[] = [];
    const consoleMethods = new Set(["log", "info", "warn", "error", "debug", "trace", "dir", "dirxml", "table", "assert", ...Object.getOwnPropertyNames(console)]);
    for (const method of consoleMethods) {
      if (typeof Reflect.get(console, method) !== "function") continue;
      vi.spyOn(console, method as "log").mockImplementation((...args: unknown[]) => {
        output.push(args.map(value => value instanceof Error ? `${value.name}: ${value.message}\n${value.stack}` :
          typeof value === "string" ? value : JSON.stringify(value)).join(" "));
      });
    }
    const secrets = [env.HMAC_PAIR_PERSONAL_WORK, env.WEBHOOK_KEY_PERSONAL_WINGBOT, env.WEBHOOK_KEY_WORK_WINGBOT, env.ADMIN_HMAC].map(String);
    const authorization = `Bearer ${env.WEBHOOK_KEY_WORK_WINGBOT}`;
    const leak = [...secrets, authorization].join(" ");
    const task = envelope();
    const request = await signed(task, PERSONAL, NOW);
    request.headers.set("Authorization", authorization);
    await expectJson(await handleRequest(request, env, NOW), 202, { id: task.id, status: "delivered" });

    // A hostile receiver may echo credentials in either a response or an exception.
    webhook(PERSONAL).respond = () => new Response(leak, { status: 500 });
    const failing = envelope({ from: WORK, to: PERSONAL });
    await send(failing);
    webhook(PERSONAL).respond = () => { throw new Error(leak); };
    await sweepAt(NOW + 60);
    await sweepAt(NOW + 180);
    expect(await messageRow(failing.id)).toMatchObject({ status: "failed", attempts: 3 });
    expect((await attempts(failing.id)).map(row => row.error)).toEqual(["http_error", "fetch_error", "fetch_error"]);
    await admin("pause", null, NOW + 180);
    await send(envelope({ ts: NOW + 180 }), NOW + 180);
    await admin("resume", null, NOW + 180);
    await sweepAt(NOW + 180);
    await admin("pause", WORK, NOW + 180);
    const bad = await signed(envelope(), PERSONAL, NOW, "/v1/messages", String(env.ADMIN_HMAC));
    await expectJson(await handleRequest(bad, env, NOW), 401, { error: "unauthorized" });

    const dump: Record<string, unknown[]> = {};
    for (const table of ["messages", "attempts", "audit", "settings", "rate_limits"]) {
      const columns = (await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results
        .map(column => column.name).filter(name => table !== "messages" || name !== "envelope_json");
      dump[table] = (await env.DB.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all()).results;
      expect(dump[table].length).toBeGreaterThan(0);
    }
    const persistedAndLogged = JSON.stringify({ output, dump });
    for (const value of [...secrets, authorization, `Bearer ${env.WEBHOOK_KEY_PERSONAL_WINGBOT}`]) {
      expect(value.length).toBeGreaterThan(10);
      expect(persistedAndLogged).not.toContain(value);
    }
  });
});

describe("acceptance: retry regressions", () => {
  it.each([["global", null], ["target", WORK]] as const)("honors a %s pause committed after selection but before the retry claim", async (_label, bot) => {
    await admin("pause", null);
    const task = envelope();
    await send(task);
    await admin("resume", null);
    const { DB } = observeD1(env.DB, async query => {
      if (query.includes("SELECT * FROM messages")) await admin("pause", bot);
    });
    await runSweep({ ...env, DB }, NOW);
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: NOW });
    await admin("resume", bot);
    await runSweep(env, NOW);
    expect(webhook(WORK).calls).toHaveLength(1);
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("delivers once when two concurrent sweeps read the same due row", async () => {
    await admin("pause", null);
    const task = envelope();
    await send(task);
    await admin("resume", null);
    let readers = 0;
    let release!: () => void;
    const bothSelected = new Promise<void>(resolve => { release = resolve; });
    const { DB } = observeD1(env.DB, async query => {
      if (!query.includes("SELECT * FROM messages")) return;
      if (++readers === 2) release();
      await bothSelected;
    });
    await Promise.all([runSweep({ ...env, DB }, NOW), runSweep({ ...env, DB }, NOW)]);
    expect(readers).toBe(2);
    expect(webhook(WORK).calls).toHaveLength(1);
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1, next_attempt_at: null });
    expect(await attempts(task.id)).toEqual([{ attempt: 1, http_status: 200, error: null }]);
  });

  it.each([200, 500])("reclaims an expired lease and ignores its late failure after a replacement returns %i", async status => {
    webhook(WORK).respond = () => new Response(null, { status: 500 });
    const task = envelope();
    await send(task);
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    let finish!: (response: Response) => void;
    const held = new Promise<Response>(resolve => { finish = resolve; });
    webhook(WORK).respond = () => { started(); return held; };
    const first = runSweep(env, NOW + 60);
    await inFlight;
    try {
      expect(await messageRow(task.id)).toMatchObject({ attempts: 1, next_attempt_at: NOW + 360 });
      webhook(WORK).respond = () => new Response(null, { status });
      await runSweep(env, NOW + 359);
      expect(webhook(WORK).calls).toHaveLength(2);
      await runSweep(env, NOW + 360);
      expect(webhook(WORK).calls).toHaveLength(3);
    } finally {
      finish(new Response(null, { status: 500 }));
      await first;
    }
    expect(await messageRow(task.id)).toMatchObject({
      status: status === 200 ? "delivered" : "queued", attempts: 2,
      next_attempt_at: status === 200 ? null : NOW + 480, last_status_code: status, updated_at: NOW + 360,
    });
    expect(await attempts(task.id)).toEqual([
      { attempt: 1, http_status: 500, error: "http_error" },
      { attempt: 2, http_status: status, error: status === 200 ? null : "http_error" },
    ]);
  });

  it.each([
    [200, 0, "delivered"], [500, 0, "queued"], [500, 2, "failed"],
  ] as const)("keeps a backlog of 25 %i responses from attempt count %i within 40 D1 statements", async (httpStatus, priorAttempts, status) => {
    await admin("pause", null);
    for (let i = 0; i < 25; i++) await send(envelope());
    await env.DB.prepare("UPDATE messages SET attempts = ?").bind(priorAttempts).run();
    await admin("resume", null);
    webhook(WORK).respond = () => new Response(null, { status: httpStatus });
    const { DB, counts } = observeD1(env.DB);
    await runSweep({ ...env, DB }, NOW);
    expect(webhook(WORK).calls).toHaveLength(7);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = ? AND attempts = ?")
      .bind(status, priorAttempts + 1).first()).toEqual({ n: 7 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts").first()).toEqual({ n: 7 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'failed'").first())
      .toEqual({ n: status === "failed" ? 7 : 0 });
    expect(counts.calls).toBeLessThanOrEqual(35);
    expect(counts.statements).toBeLessThanOrEqual(40);
    expect(counts.pauseReads).toBe(1);
  });

  it("honors a pause committed after insertion but before the inline delivery", async () => {
    // Keep D1 real, but interleave a signed admin pause when the accepted audit
    // is written, after the insertion-time pause snapshot and before delivery.
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property !== "prepare") return Reflect.get(target, property, target);
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("INSERT INTO audit")) return statement;
          return new Proxy(statement, {
            get(targetStatement, method) {
              if (method !== "bind") return Reflect.get(targetStatement, method, targetStatement);
              return (...values: unknown[]) => {
                const bound = targetStatement.bind(...values);
                if (values[1] !== "accepted") return bound;
                return new Proxy(bound, {
                  get(targetBound, operation) {
                    if (operation !== "run") return Reflect.get(targetBound, operation, targetBound);
                    return async () => {
                      await admin("pause", WORK);
                      return targetBound.run();
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    const task = envelope();
    await expectJson(await send(task, NOW, { ...env, DB: database }), 202, { id: task.id, status: "queued" });
    expect(webhook(WORK).calls).toHaveLength(0);
    expect(await messageRow(task.id)).toMatchObject({ attempts: 0, next_attempt_at: NOW });
    await admin("resume", WORK, NOW + 1);
    await sweepAt(NOW + 1);
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("does not let cron deliver a message while its inline attempt is in flight", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>(resolve => { started = resolve; });
    let finish!: (response: Response) => void;
    const heldResponse = new Promise<Response>(resolve => { finish = resolve; });
    webhook(WORK).respond = () => {
      if (webhook(WORK).calls.length === 1) {
        started();
        return heldResponse;
      }
      return new Response(null, { status: 200 });
    };
    const task = envelope();
    const inline = send(task);
    await inFlight;
    try {
      await sweepAt(NOW + 1);
      expect(webhook(WORK).calls).toHaveLength(1);
      expect(await messageRow(task.id)).toMatchObject({ attempts: 0, status: "queued", next_attempt_at: NOW + 60 });
    } finally {
      finish(new Response(null, { status: 200 }));
      await inline;
    }
    expect(await messageRow(task.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await attempts(task.id)).toHaveLength(1);
  });

  it("does not let twenty paused targets starve another bot's due retry", async () => {
    await expectJson(await admin("pause", WORK), 200, { key: `paused:${WORK}`, value: "1" });
    const pausedIds: string[] = [];
    for (let i = 0; i < 20; i++) {
      const task = envelope();
      pausedIds.push(task.id);
      await expectJson(await send(task), 202, { id: task.id, status: "queued" });
    }
    webhook(PERSONAL).respond = () => new Response(null, { status: webhook(PERSONAL).calls.length === 1 ? 500 : 200 });
    const other = envelope({ from: WORK, to: PERSONAL });
    await expectJson(await send(other), 202, { id: other.id, status: "queued" });
    await sweepAt(NOW + 60);
    expect(await messageRow(other.id)).toMatchObject({ status: "delivered", attempts: 2 });
    expect(webhook(PERSONAL).calls).toHaveLength(2);
    expect(webhook(WORK).calls).toHaveLength(0);
    for (const id of pausedIds) {
      expect(await messageRow(id)).toMatchObject({ status: "queued", attempts: 0, next_attempt_at: NOW });
    }
  });

  it("excludes globally paused messages from the SQL retry selection and restores them immediately on resume", async () => {
    await admin("pause", null);
    const task = envelope();
    await send(task);
    const store = makeStore(env.DB);
    expect(await store.dueForRetry(NOW, 20)).toEqual([]);
    await admin("resume", null);
    expect((await store.dueForRetry(NOW, 20)).map(row => row.id)).toEqual([task.id]);
  });
});

describe("acceptance: worker review regressions", () => {
  it("a 401 flood on message and both admin routes makes zero D1 operations or audit rows", async () => {
    const { DB, counts } = observeD1(env.DB);
    for (const path of ["/v1/messages", "/v1/admin/pause", "/v1/admin/resume"]) {
      for (let i = 0; i < 20; i++) {
        const isAdmin = path !== "/v1/messages";
        const body = isAdmin ? { bot: null } : envelope();
        const req = await signed(body, isAdmin ? "admin" : PERSONAL, NOW, path, "wrong-test-secret");
        if (i % 2) req.headers.delete("X-Wingbot-Signature");
        await expectJson(await handleRequest(req, { ...env, DB }, NOW), 401, { error: "unauthorized" });
      }
    }
    expect(counts.statements).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit").first()).toEqual({ n: 0 });
    expect(webhook(WORK).calls).toHaveLength(0);
  });

  it("continues auditing authenticated 400, 409, 429 and accepted messages", async () => {
    const bindings = { ...env, REGISTRY_JSON: JSON.stringify({ ...registry, bots: registry.bots.map(bot => ({ ...bot, rate_limit_per_min: 2 })) }) };
    await expectJson(await send(envelope({ id: "invalid" }), NOW, bindings), 400, { error: "bad_request" });
    const task = envelope();
    await expectJson(await send(task, NOW, bindings), 202, { id: task.id, status: "delivered" });
    await expectJson(await send(task, NOW, bindings), 409, { error: "duplicate" });
    await expectJson(await send(envelope(), NOW, bindings), 429, { error: "rate_limited" });
    const events = (await env.DB.prepare("SELECT event FROM audit ORDER BY id").all<{ event: string }>()).results.map(row => row.event);
    expect(events).toEqual(["rejected", "accepted", "duplicate", "rate_limited"]);
  });

  it("audits authenticated admin schema errors without changing settings", async () => {
    for (const action of ["pause", "resume"]) {
      const request = await signed({ bot: null, extra: true }, "admin", NOW, `/v1/admin/${action}`, String(env.ADMIN_HMAC));
      await expectJson(await handleRequest(request, env, NOW), 400, { error: "bad_request" });
    }
    expect((await env.DB.prepare("SELECT event FROM audit ORDER BY id").all()).results)
      .toEqual([{ event: "rejected" }, { event: "rejected" }]);
    expect((await env.DB.prepare("SELECT * FROM settings").all()).results).toEqual([]);
  });

  it.each(["/v1/messages?x=1", "/v1/admin/pause?x=1", "/v1/admin/resume?x=1", "/unknown", "/v1/messages/"])("rejects %s before loading an invalid registry", async path => {
    const { DB, counts } = observeD1(env.DB);
    const req = new Request(`https://wingbot.test${path}`, { method: "POST" });
    await expectJson(await handleRequest(req, { ...env, DB, REGISTRY_JSON: "invalid" }, NOW), 404, { error: "not_found" });
    expect(counts.statements).toBe(0);
  });

  it.each(["/v1/messages", "/v1/admin/pause", "/v1/admin/resume"])("returns a generic JSON 500 for invalid registry on %s", async path => {
    await expectJson(await handleRequest(new Request(`https://wingbot.test${path}`, { method: "POST" }),
      { ...env, REGISTRY_JSON: "invalid" }, NOW), 500, { error: "internal_error" });
  });

  it("contains unexpected storage errors without exposing their messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const DB = new Proxy(env.DB, { get(target, property) {
      if (property === "prepare") return () => { throw new Error("private-internal-test-marker"); };
      return Reflect.get(target, property, target);
    } });
    await expectJson(await send(envelope(), NOW, { ...env, DB }), 500, { error: "internal_error" });
    expect(log.mock.calls).toEqual([[JSON.stringify({ event: "internal_error", error_class: "Error" })]]);
    expect(webhook(WORK).calls).toHaveLength(0);
  });

  it.each([null, WORK] as const)("audits admin pause/resume and returns the setting for %s", async bot => {
    const key = bot ? `paused:${bot}` : "paused";
    await expectJson(await admin("pause", bot), 200, { key, value: "1" });
    expect(await makeStore(env.DB).isPaused(bot ?? undefined)).toBe(true);
    await expectJson(await admin("resume", bot), 200, { key, value: "0" });
    expect(await makeStore(env.DB).isPaused(bot ?? undefined)).toBe(false);
    expect((await env.DB.prepare("SELECT event, to_bot, detail FROM audit ORDER BY id").all()).results).toEqual([
      { event: "admin_pause", to_bot: bot, detail: bot ? "bot" : "global" },
      { event: "admin_resume", to_bot: bot, detail: bot ? "bot" : "global" },
    ]);
  });

  it.each([
    ["disabled sender", (r: Registry) => { r.bots[0].enabled = false; }],
    ["disabled target", (r: Registry) => { r.bots[1].enabled = false; }],
    ["disabled pair", (r: Registry) => { r.pairs[0].enabled = false; }],
    ["missing pair", (r: Registry) => { r.pairs = []; }],
    ["missing sender", (r: Registry) => { r.bots.shift(); r.pairs = []; }],
    ["missing target", (r: Registry) => { r.bots.pop(); r.pairs = []; }],
    ["renamed pair", (r: Registry) => { r.pairs[0].name = "replacement"; }],
    ["changed pair endpoints", (r: Registry) => {
      r.bots.push({ ...r.bots[0], id: "other:bot", webhook_key_secret: "WEBHOOK_KEY_OTHER" });
      r.pairs[0].bots = [PERSONAL, "other:bot"];
    }],
  ] as const)("fails a revoked route without dispatching or consuming an attempt: %s", async (_label, edit) => {
    webhook(WORK).respond = () => new Response(null, { status: 500 });
    const task = envelope();
    await send(task);
    const changed = JSON.parse(env.REGISTRY_JSON) as Registry;
    edit(changed);
    await runSweep({ ...env, REGISTRY_JSON: JSON.stringify(changed) }, NOW + 60);
    expect(webhook(WORK).calls).toHaveLength(1);
    expect(await messageRow(task.id)).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
    expect(await attempts(task.id)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT event, detail FROM audit WHERE message_id = ? AND event = 'route_revoked'").bind(task.id).all()).results)
      .toEqual([{ event: "route_revoked", detail: "route_revoked" }]);
    await runSweep({ ...env, REGISTRY_JSON: JSON.stringify(changed) }, NOW + 120);
    expect(webhook(WORK).calls).toHaveLength(1);
  });
});
