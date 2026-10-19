import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { makeStore } from "../src/store/d1";
import type { BotId, MessageRow } from "../src/types";

const store = makeStore(env.DB);
const T0 = 1_800_000_000;

let seq = 0;
function row(overrides: Partial<MessageRow> = {}): MessageRow {
  seq += 1;
  return {
    id: `msg-${seq}-${crypto.randomUUID()}`,
    pair: "personal-work",
    from_bot: "personal:wingbot",
    to_bot: "work:wingbot",
    kind: "task",
    reply_to: null,
    body_sha256: "a".repeat(64),
    size: 123,
    status: "queued",
    attempts: 0,
    next_attempt_at: T0,
    created_at: T0,
    updated_at: T0,
    last_status_code: null,
    envelope_json: "{}",
    ...overrides,
  };
}

const getMessage = (id: string) =>
  env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
const countAttempts = async (id: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM attempts WHERE message_id = ?")
    .bind(id)
    .first<{ n: number }>())!.n;

describe("insertMessage / claimId", () => {
  it("inserts once and returns false for a duplicate id", async () => {
    const m = row();
    expect(await store.insertMessage(m)).toBe(true);
    expect(await store.claimId(m)).toBe(false);
    expect(await store.insertMessage({ ...m, pair: "other" })).toBe(false);
    expect((await getMessage(m.id))!.pair).toBe("personal-work");
  });

  it("propagates non-conflict errors (CHECK constraint)", async () => {
    await expect(
      store.insertMessage(row({ status: "bogus" as MessageRow["status"] })),
    ).rejects.toThrow();
  });
});

describe("recordAttempt / markStatus", () => {
  it.each(["queued", "failed"] as const)("does not let a late %s completion overwrite delivered metadata", async status => {
    const m = row({ status: "delivered", attempts: 2, next_attempt_at: null, last_status_code: 200 });
    await store.insertMessage(m);
    await store.recordAttempt(m.id, 3, { ok: false, http_status: 500, error: "http_error", started_at: T0 + 1, duration_ms: 0 });
    await store.markStatus(m.id, status, T0 + 1, status === "queued" ? T0 + 120 : null, 500);
    expect(await getMessage(m.id)).toEqual(m);
    expect(await countAttempts(m.id)).toBe(0);
  });

  it("records the attempt and updates the message", async () => {
    const m = row();
    await store.insertMessage(m);
    await store.recordAttempt(m.id, 1, {
      ok: false,
      http_status: 500,
      error: "http_500",
      started_at: T0 + 5,
      duration_ms: 2500,
    });
    let got = (await getMessage(m.id))!;
    expect(got.attempts).toBe(1);
    expect(got.last_status_code).toBe(500);
    expect(got.updated_at).toBe(T0 + 7);
    expect(await countAttempts(m.id)).toBe(1);

    await store.markStatus(m.id, "delivered", T0 + 100, null, 200);
    got = (await getMessage(m.id))!;
    expect(got.status).toBe("delivered");
    expect(got.next_attempt_at).toBeNull();
    expect(got.last_status_code).toBe(200);
    expect(got.updated_at).toBe(T0 + 100);
  });
});

describe("claimRetry", () => {
  it("fences an expired lease before its replacement completes, including terminal failure audits", async () => {
    const m = row({ attempts: 2 });
    await store.insertMessage(m);
    const original = await store.claimRetry(m.id, 2, T0);
    expect(original).not.toBeNull();
    expect(await store.claimRetry(m.id, 2, T0 + 299)).toBeNull();
    const replacement = await makeStore(env.DB).claimRetry(m.id, 2, T0 + 300);
    expect(replacement).not.toBeNull();
    const before = await getMessage(m.id);
    await original!.complete({ ok: false, http_status: 500, error: "http_error", started_at: T0, duration_ms: 0 });
    expect(await getMessage(m.id)).toEqual(before);
    expect(await countAttempts(m.id)).toBe(0);
    expect((await env.DB.prepare("SELECT * FROM audit WHERE message_id = ?").bind(m.id).all()).results).toEqual([]);
    await replacement!.complete({ ok: true, http_status: 200, error: null, started_at: T0 + 300, duration_ms: 0 });
    expect(await getMessage(m.id)).toMatchObject({ status: "delivered", attempts: 3, next_attempt_at: null });
    expect(await countAttempts(m.id)).toBe(1);
  });

  it.each([
    { status: "delivered" }, { status: "failed" }, { next_attempt_at: null },
    { next_attempt_at: T0 + 1 }, { attempts: 3 }, { attempts: 1 },
  ] satisfies Partial<MessageRow>[])("refuses an ineligible or changed retry: %j", async overrides => {
    const m = row(overrides);
    await store.insertMessage(m);
    expect(await store.claimRetry(m.id, overrides.attempts === 3 ? 3 : 0, T0)).toBeNull();
    expect(await getMessage(m.id)).toEqual(m);
  });
});

describe("dueForRetry", () => {
  it("selects only queued, due, under-limit messages in next_attempt_at order", async () => {
    const base = T0 + 10_000;
    const later = row({ next_attempt_at: base - 10 });
    const earlier = row({ next_attempt_at: base - 50 });
    const exact = row({ next_attempt_at: base });
    const future = row({ next_attempt_at: base + 1 });
    const exhausted = row({ next_attempt_at: base - 100, attempts: 3 });
    const delivered = row({ next_attempt_at: base - 100, status: "delivered" });
    const noSchedule = row({ next_attempt_at: null });
    for (const m of [later, earlier, exact, future, exhausted, delivered, noSchedule]) {
      await store.insertMessage(m);
    }

    const ids = (await store.dueForRetry(base, 100)).map((m) => m.id);
    const mine = ids.filter((id) =>
      [later, earlier, exact, future, exhausted, delivered, noSchedule].some((m) => m.id === id),
    );
    expect(mine).toEqual([earlier.id, later.id, exact.id]);

    const due = await store.dueForRetry(base, 1);
    expect(due).toHaveLength(1);
    expect(due[0].envelope_json).toBe("{}");
  });
});

describe("pause", () => {
  it("handles global and per-bot pause", async () => {
    const a: BotId = "work:wingbot";
    const b: BotId = "personal:wingbot";

    expect(await store.isPaused()).toBe(false);
    expect(await store.isPaused(a)).toBe(false);

    await store.setPaused(a, true);
    expect(await store.isPaused(a)).toBe(true);
    expect(await store.isPaused(b)).toBe(false);
    expect(await store.isPaused()).toBe(false);

    await store.setPaused(null, true);
    expect(await store.isPaused()).toBe(true);
    expect(await store.isPaused(b)).toBe(true);

    await store.setPaused(null, false);
    await store.setPaused(a, false);
    expect(await store.isPaused()).toBe(false);
    expect(await store.isPaused(a)).toBe(false);
  });
});

describe("hitRateLimit", () => {
  it("counts per fixed 60 s window and resets in the next window", async () => {
    const bot: BotId = "ratetest:bot-1";
    const w = T0 - (T0 % 60);
    expect(await store.hitRateLimit(bot, 2, w + 1)).toBe(false);
    expect(await store.hitRateLimit(bot, 2, w + 30)).toBe(false);
    expect(await store.hitRateLimit(bot, 2, w + 59)).toBe(true);
    // Another bot is independent.
    expect(await store.hitRateLimit("ratetest:bot-2", 2, w + 59)).toBe(false);
    // Next window resets.
    expect(await store.hitRateLimit(bot, 2, w + 60)).toBe(false);
  });

  it("prunes windows older than an hour on the first hit of a new window", async () => {
    const bot: BotId = "ratetest:bot-3";
    const w = T0 - (T0 % 60);
    await store.hitRateLimit(bot, 10, w);
    await store.hitRateLimit(bot, 10, w + 2 * 3600);
    const { results } = await env.DB.prepare(
      "SELECT window_start FROM rate_limits WHERE bot = ?",
    )
      .bind(bot)
      .all<{ window_start: number }>();
    expect(results.map((r) => r.window_start)).toEqual([w + 2 * 3600]);
  });
});

describe("audit", () => {
  it("inserts and truncates detail to 64 chars", async () => {
    await store.audit({
      at: T0,
      event: "rejected-trunc-test",
      message_id: null,
      from_bot: null,
      to_bot: null,
      kind: null,
      body_sha256: null,
      detail: "x".repeat(200),
    });
    const got = await env.DB.prepare("SELECT detail FROM audit WHERE event = ?")
      .bind("rejected-trunc-test")
      .first<{ detail: string }>();
    expect(got!.detail).toHaveLength(64);
  });
});

describe("purgeOld", () => {
  it("deletes old terminal messages with their attempts and old audit rows", async () => {
    const now = T0 + 100 * 86400;
    const old = now - 7 * 86400 - 1;
    const oldDelivered = row({ status: "delivered", updated_at: old });
    const oldFailed = row({ status: "failed", updated_at: old });
    const oldQueued = row({ status: "queued", updated_at: old });
    const recentDelivered = row({ status: "delivered", updated_at: now - 86400 });
    for (const m of [oldDelivered, oldFailed, oldQueued, recentDelivered]) {
      await store.insertMessage(m);
      await env.DB.prepare(
        "INSERT INTO attempts (message_id, attempt, http_status, error, started_at, duration_ms) VALUES (?, 1, 200, NULL, ?, 10)",
      )
        .bind(m.id, old)
        .run();
    }
    for (const [event, at] of [
      ["purge-old", now - 31 * 86400],
      ["purge-recent", now - 29 * 86400],
    ] as const) {
      await store.audit({
        at,
        event,
        message_id: null,
        from_bot: null,
        to_bot: null,
        kind: null,
        body_sha256: null,
        detail: null,
      });
    }

    await store.purgeOld(now);

    expect(await getMessage(oldDelivered.id)).toBeNull();
    expect(await getMessage(oldFailed.id)).toBeNull();
    expect(await countAttempts(oldDelivered.id)).toBe(0);
    expect(await countAttempts(oldFailed.id)).toBe(0);
    expect(await getMessage(oldQueued.id)).not.toBeNull();
    expect(await countAttempts(oldQueued.id)).toBe(1);
    expect(await getMessage(recentDelivered.id)).not.toBeNull();
    expect(await countAttempts(recentDelivered.id)).toBe(1);

    const { results } = await env.DB.prepare(
      "SELECT event FROM audit WHERE event LIKE 'purge-%'",
    ).all<{ event: string }>();
    expect(results.map((r) => r.event)).toEqual(["purge-recent"]);
  });
});

describe("route revocation", () => {
  it("atomically fails a due row with an audit but no attempt", async () => {
    const m = row({ attempts: 1 });
    await store.insertMessage(m);
    await store.failRetry(m, T0);
    expect(await getMessage(m.id)).toMatchObject({ status: "failed", attempts: 1, next_attempt_at: null });
    expect(await countAttempts(m.id)).toBe(0);
    expect((await env.DB.prepare("SELECT event, detail FROM audit WHERE message_id = ?").bind(m.id).all()).results)
      .toEqual([{ event: "route_revoked", detail: "route_revoked" }]);
    await store.failRetry(m, T0);
    expect((await env.DB.prepare("SELECT event FROM audit WHERE message_id = ?").bind(m.id).all()).results).toHaveLength(1);
  });

  it("does not revoke a stale selection after another sweep acquires a lease", async () => {
    const m = row();
    await store.insertMessage(m);
    const lease = await store.claimRetry(m.id, 0, T0);
    expect(lease).not.toBeNull();
    const leased = await getMessage(m.id);
    await store.failRetry(m, T0);
    expect(await getMessage(m.id)).toEqual(leased);
    expect((await env.DB.prepare("SELECT event FROM audit WHERE message_id = ?").bind(m.id).all()).results).toEqual([]);
    await lease!.complete({ ok: true, http_status: 200, error: null, started_at: T0, duration_ms: 0 });
    await store.failRetry(m, T0 + 300);
    expect(await getMessage(m.id)).toMatchObject({ status: "delivered", attempts: 1 });
    expect(await countAttempts(m.id)).toBe(1);
  });

  it("fences a late completion after revoking an expired lease", async () => {
    const m = row();
    await store.insertMessage(m);
    const lease = await store.claimRetry(m.id, 0, T0);
    const expired = (await getMessage(m.id))!;
    await store.failRetry(expired, T0 + 300);
    await lease!.complete({ ok: true, http_status: 200, error: null, started_at: T0, duration_ms: 0 });
    expect(await getMessage(m.id)).toMatchObject({ status: "failed", attempts: 0, next_attempt_at: null });
    expect(await countAttempts(m.id)).toBe(0);
    expect((await env.DB.prepare("SELECT event FROM audit WHERE message_id = ?").bind(m.id).all()).results)
      .toEqual([{ event: "route_revoked" }]);
  });
});
