import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { loadRegistry, findPair } from "../src/registry";
import { verifyAdmin, verifyRequest } from "../src/verify";
import type { Envelope, Env, Registry } from "../src/types";

const now = 1700000000;
const from = "personal:wingbot";
const to = "work:wingbot";
const unauthorized = { ok: false, status: 401, error: "unauthorized" };
const badRequest = { ok: false, status: 400, error: "bad_request" };
const encoder = new TextEncoder();
const envelope: Envelope = {
  v: 1, id: "d86d861e-b41c-45ee-a9dd-6787f509d4e5", kind: "task",
  from, to, task: "Run the task", context: {}, reply_to: null, ts: now,
};

// Independent signing fixture: no dependency on the production HMAC helpers.
async function signed(
  body: unknown = envelope,
  options: { raw?: string; path?: string; bot?: string; timestamp?: string; secret?: string } = {},
): Promise<Request> {
  const raw = options.raw ?? JSON.stringify(body);
  const path = options.path ?? "/v1/messages";
  const timestamp = options.timestamp ?? String(now);
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(options.secret ?? String(env.HMAC_PAIR_PERSONAL_WORK)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = hex(await crypto.subtle.sign(
    "HMAC", key, encoder.encode(`wingbot-v1\n${timestamp}\nPOST\n${path}\n${hex(hash)}`),
  ));
  return new Request(`https://wingbot.test${path}`, {
    method: "POST", body: raw,
    headers: {
      "Content-Type": "application/json", "X-Wingbot-Bot": options.bot ?? from,
      "X-Wingbot-Timestamp": timestamp, "X-Wingbot-Signature": `v1=${signature}`,
    },
  });
}

function registryEnv(edit: (registry: Registry) => void): Env {
  const registry = JSON.parse(env.REGISTRY_JSON) as Registry;
  edit(registry);
  return { ...env, REGISTRY_JSON: JSON.stringify(registry) };
}

describe("verifyRequest", () => {
  it("authenticates raw bytes and returns the registered pair and bots", async () => {
    const raw = JSON.stringify(envelope, null, 2);
    const result = await verifyRequest(await signed(envelope, { raw }), env, now);
    expect(result).toMatchObject({ ok: true, envelope, size: encoder.encode(raw).byteLength });
    if (!result.ok) throw new Error("expected authenticated request");
    expect(result.from.id).toBe(from);
    expect(result.to.id).toBe(to);
    expect(result.pair.name).toBe("personal-work");
    expect(result.body_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("supports the reverse direction and result replies", async () => {
    const reply = { ...envelope, from: to, to: from, kind: "result", reply_to: envelope.id };
    expect(await verifyRequest(await signed(reply, { bot: to }), env, now)).toMatchObject({ ok: true, envelope: reply });
  });

  it.each([-300, 300])("accepts a timestamp at the %i second boundary", async offset => {
    expect(await verifyRequest(await signed(), env, now + offset)).toMatchObject({ ok: true });
  });

  it.each([-301, 301])("rejects a timestamp outside the %i second boundary", async offset => {
    expect(await verifyRequest(await signed(), env, now + offset)).toEqual(unauthorized);
  });

  it.each(["X-Wingbot-Bot", "X-Wingbot-Timestamp", "X-Wingbot-Signature"])("rejects a missing %s", async header => {
    const req = await signed();
    req.headers.delete(header);
    expect(await verifyRequest(req, env, now)).toEqual(unauthorized);
  });

  it.each([
    ["X-Wingbot-Bot", "unknown:bot"], ["X-Wingbot-Bot", "Personal:wingbot"],
    ["X-Wingbot-Timestamp", "1700000000.5"], ["X-Wingbot-Timestamp", "1.7e9"],
    ["X-Wingbot-Timestamp", "9007199254740992"],
    ["X-Wingbot-Signature", `v1=${"0".repeat(64)}`],
    ["X-Wingbot-Signature", `v1=${"A".repeat(64)}`],
    ["X-Wingbot-Signature", `v2=${"a".repeat(64)}`],
    ["X-Wingbot-Signature", "v1=abcd"],
  ])("rejects malformed or invalid %s (%s)", async (header, value) => {
    const req = await signed();
    req.headers.set(header, value);
    expect(await verifyRequest(req, env, now)).toEqual(unauthorized);
  });

  it.each([
    (r: Registry) => { r.bots[0].enabled = false; },
    (r: Registry) => { r.bots[1].enabled = false; },
    (r: Registry) => { r.pairs[0].enabled = false; },
    (r: Registry) => { r.pairs = []; },
  ])("rejects disabled bots and unavailable pairs", async edit => {
    expect(await verifyRequest(await signed(), registryEnv(edit), now)).toEqual(unauthorized);
  });

  it("rejects missing pair secrets without throwing", async () => {
    expect(await verifyRequest(await signed(), { ...env, HMAC_PAIR_PERSONAL_WORK: undefined }, now)).toEqual(unauthorized);
  });

  it.each(["{broken", "null", "[]", "{}"])("rejects JSON that cannot locate a pair (%s)", async raw => {
    expect(await verifyRequest(await signed(undefined, { raw }), env, now)).toEqual(unauthorized);
  });

  it("rejects a changed raw body even when the parsed envelope is unchanged", async () => {
    const req = await signed();
    const changed = new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(envelope) + " " });
    expect(await verifyRequest(changed, env, now)).toEqual(unauthorized);
  });

  it("accepts exactly 64 KiB but rejects one extra byte before schema validation", async () => {
    const raw = JSON.stringify(envelope).padEnd(65536, " ");
    expect(await verifyRequest(await signed(undefined, { raw }), env, now)).toMatchObject({ ok: true, size: 65536 });
    expect(await verifyRequest(await signed(undefined, { raw: raw + " " }), env, now)).toEqual(unauthorized);
  });

  it.each([{ from: to }, { ts: now - 1 }, { ts: String(now) }])("rejects authenticated identity or timestamp mismatches", async change => {
    expect(await verifyRequest(await signed({ ...envelope, ...change }), env, now)).toEqual(unauthorized);
  });

  it("does not report schema errors until the signature is valid", async () => {
    const req = await signed({ ...envelope, v: 2 });
    req.headers.set("X-Wingbot-Signature", `v1=${"0".repeat(64)}`);
    expect(await verifyRequest(req, env, now)).toEqual(unauthorized);
    expect(await verifyRequest(await signed({ ...envelope, v: 2 }), env, now)).toEqual(badRequest);
  });

  it.each([
    { v: 2 }, { id: "not-a-uuid" }, { id: "d86d861e-b41c-15ee-a9dd-6787f509d4e5" },
    { id: envelope.id.toUpperCase() }, { id: "D86d861e-b41c-45ee-a9dd-6787f509d4e5" },
    { reply_to: envelope.id.toUpperCase() }, { reply_to: "D86d861e-b41c-45ee-a9dd-6787f509d4e5" },
    { extra: true }, { kind: "other" }, { task: 1 }, { task: "é".repeat(8193) },
    { context: null }, { context: [] }, { reply_to: "not-a-uuid" },
    { reply_to: undefined }, { kind: "result", reply_to: null },
  ])("returns 400 for an authenticated schema violation (%j)", async change => {
    expect(await verifyRequest(await signed({ ...envelope, ...change }), env, now)).toEqual(badRequest);
  });

  it("allows a task of exactly 16 KiB in UTF-8", async () => {
    expect(await verifyRequest(await signed({ ...envelope, task: "é".repeat(8192) }), env, now)).toMatchObject({ ok: true });
  });

  it("validates JSON content type after authentication", async () => {
    const req = await signed();
    req.headers.set("Content-Type", "text/plain");
    expect(await verifyRequest(req, env, now)).toEqual(badRequest);
  });
});

describe("verifyAdmin", () => {
  const options = { bot: "admin", path: "/v1/admin/pause", secret: String(env.ADMIN_HMAC) };

  it.each(["/v1/admin/pause", "/v1/admin/resume"])("authenticates global and bot settings on %s", async path => {
    for (const bot of [null, to]) {
      expect(await verifyAdmin(await signed({ bot }, { ...options, path }), env, now)).toEqual({ ok: true, bot });
    }
  });

  it("binds signatures to the admin route", async () => {
    const req = await signed({ bot: null }, options);
    const changed = new Request("https://wingbot.test/v1/admin/resume", req);
    expect(await verifyAdmin(changed, env, now)).toEqual(unauthorized);
  });

  it.each([
    { bot: from }, { secret: "wrong-admin-secret" }, { timestamp: String(now - 301) },
  ])("rejects invalid admin authentication", async change => {
    expect(await verifyAdmin(await signed({ bot: null }, { ...options, ...change }), env, now)).toEqual(unauthorized);
  });

  it("rejects a missing admin secret", async () => {
    expect(await verifyAdmin(await signed({ bot: null }, options), { ...env, ADMIN_HMAC: undefined }, now)).toEqual(unauthorized);
  });

  it.each([{}, { bot: null, extra: true }, { bot: to, extra: true }, { bot: "unknown:bot" }, { bot: 123 }, null, []])("returns 400 for a signed invalid admin body (%j)", async body => {
    expect(await verifyAdmin(await signed(body, options), env, now)).toEqual(badRequest);
  });

  it("rejects malformed or oversized admin JSON with 401", async () => {
    for (const raw of ["{broken", JSON.stringify({ bot: null }).padEnd(1025, " ")]) {
      expect(await verifyAdmin(await signed(undefined, { ...options, raw }), env, now)).toEqual(unauthorized);
    }
  });
});

describe("registry validation", () => {
  it("caches by registry string and finds enabled pairs in either order", () => {
    const registry = loadRegistry(env);
    expect(loadRegistry({ ...env })).toBe(registry);
    expect(findPair(registry, from, to)?.name).toBe("personal-work");
    expect(findPair(registry, to, from)?.name).toBe("personal-work");
    expect(findPair(registry, from, from)).toBeUndefined();
    const disabled = loadRegistry(registryEnv(r => { r.pairs[0].enabled = false; }));
    expect(findPair(disabled, from, to)).toBeUndefined();
  });

  it.each([
    (r: Registry) => { r.bots.push({ ...r.bots[0] }); },
    (r: Registry) => { r.bots[0].id = "Bad:bot"; },
    (r: Registry) => { r.bots[0].webhook_url = "http://example.com/webhook"; },
    (r: Registry) => { r.bots[0].webhook_url = "invalid"; },
    (r: Registry) => { r.bots[0].rate_limit_per_min = 0; },
    (r: Registry) => { r.bots[0].webhook_key_secret = ""; },
    (r: Registry) => { r.pairs[0].bots[1] = "unknown:bot"; },
    (r: Registry) => { r.pairs[0].bots[1] = from; },
    (r: Registry) => { r.pairs[0].hmac_secret = ""; },
  ])("rejects invalid registry entries", edit => {
    expect(() => loadRegistry(registryEnv(edit))).toThrow("invalid_registry");
  });
});

describe("bounded body reads", () => {
  const routes = [
    { path: "/v1/messages", limit: 65536, body: envelope, bot: from, secret: String(env.HMAC_PAIR_PERSONAL_WORK), verify: verifyRequest },
    { path: "/v1/admin/pause", limit: 1024, body: { bot: null }, bot: "admin", secret: String(env.ADMIN_HMAC), verify: verifyAdmin },
    { path: "/v1/admin/resume", limit: 1024, body: { bot: to }, bot: "admin", secret: String(env.ADMIN_HMAC), verify: verifyAdmin },
  ];

  it.each(routes)("rejects advertised oversize on $path before reading", async route => {
    let reads = 0;
    const request = await signed(route.body, route);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(encoder.encode(JSON.stringify(route.body))); controller.close(); },
    }, { highWaterMark: 0 });
    const req = new Request(request.url, { method: "POST", headers: request.headers, body: stream });
    req.headers.set("Content-Length", String(route.limit + 1));
    expect(await route.verify(req, env, now)).toEqual(unauthorized);
    expect(reads).toBe(0);
  });

  for (const advertised of [undefined, "1"]) {
    it.each(routes)(`cancels $path at the first excess byte (Content-Length ${advertised ?? "absent"})`, async route => {
      const raw = JSON.stringify(route.body).padEnd(route.limit, " ");
      const signedReq = await signed(route.body, { ...route, raw: raw + "  " });
      let reads = 0;
      let canceled = false;
      const chunks = [encoder.encode(raw), encoder.encode(" "), encoder.encode(" ")];
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[reads++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() { canceled = true; },
      }, { highWaterMark: 0 });
      const req = new Request(signedReq.url, { method: "POST", headers: signedReq.headers, body: stream });
      if (advertised !== undefined) req.headers.set("Content-Length", advertised);
      expect(await route.verify(req, env, now)).toEqual(unauthorized);
      expect(reads).toBe(2);
      expect(canceled).toBe(true);
    });
  }

  it.each(routes)("rejects invalid UTF-8 on $path", async route => {
    const signedReq = await signed(route.body, route);
    const req = new Request(signedReq.url, { method: "POST", headers: signedReq.headers, body: new Uint8Array([0xff]) });
    expect(await route.verify(req, env, now)).toEqual(unauthorized);
  });

  it.each(routes)("keeps $path oversize rejection generic if cancellation fails", async route => {
    const signedReq = await signed(route.body, route);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(route.limit + 1)); },
      cancel() { throw new Error("stream-cancel-test-marker"); },
    }, { highWaterMark: 0 });
    const req = new Request(signedReq.url, { method: "POST", headers: signedReq.headers, body: stream });
    expect(await route.verify(req, env, now)).toEqual(unauthorized);
  });

  it.each(routes)("accepts exactly the $path byte limit across chunks", async route => {
    const raw = JSON.stringify(route.body).padEnd(route.limit, " ");
    const signedReq = await signed(route.body, { ...route, raw });
    const bytes = encoder.encode(raw);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    } });
    const req = new Request(signedReq.url, { method: "POST", headers: signedReq.headers, body: stream });
    expect(await route.verify(req, env, now)).toMatchObject({ ok: true });
  });
});
