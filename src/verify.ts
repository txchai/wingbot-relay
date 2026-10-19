import type * as Ports from "./ports";
import type { BotId, Envelope, Env, VerifyErr } from "./types";
import { canonicalString, hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "./hmac";
import { BOT_ID_PATTERN, findPair, loadRegistry } from "./registry";

const unauthorized = (): VerifyErr => ({ ok: false, status: 401, error: "unauthorized" });
const badRequest = (): VerifyErr => ({ ok: false, status: 400, error: "bad_request" });
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVELOPE_KEYS = ["v", "id", "kind", "from", "to", "task", "context", "reply_to", "ts"];
const encoder = new TextEncoder();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function authHeaders(req: Request) {
  const bot = req.headers.get("X-Wingbot-Bot");
  const timestamp = req.headers.get("X-Wingbot-Timestamp");
  const signature = req.headers.get("X-Wingbot-Signature");
  if (!bot || !timestamp || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
    || !signature || !/^v1=[0-9a-f]{64}$/.test(signature)) return undefined;
  return { bot, timestamp, signature: signature.slice(3), ts: Number(timestamp) };
}

async function readBody(req: Request, limit: number): Promise<{ bytes: ArrayBuffer; body: unknown } | undefined> {
  if (Number(req.headers.get("Content-Length")) > limit || !req.body) return undefined;
  const reader = req.body.getReader();
  try {
    const buffer = new Uint8Array(limit);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - size) {
        // Cancellation errors must not turn an unauthenticated rejection into a 500.
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      buffer.set(value, size);
      size += value.byteLength;
    }
    const bytes = buffer.buffer.slice(0, size);
    return { bytes, body: JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)) };
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function jsonContentType(req: Request): boolean {
  return req.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function validEnvelope(body: unknown): body is Envelope {
  return object(body) && Object.keys(body).length === ENVELOPE_KEYS.length
    && ENVELOPE_KEYS.every(key => Object.hasOwn(body, key))
    && body.v === 1 && typeof body.id === "string" && UUID_V4.test(body.id)
    && (body.kind === "task" || body.kind === "result")
    && typeof body.from === "string" && BOT_ID_PATTERN.test(body.from)
    && typeof body.to === "string" && BOT_ID_PATTERN.test(body.to)
    && typeof body.task === "string" && encoder.encode(body.task).byteLength <= 16384
    && object(body.context)
    && (body.reply_to === null || (typeof body.reply_to === "string" && UUID_V4.test(body.reply_to)))
    && (body.kind !== "result" || body.reply_to !== null)
    && Number.isSafeInteger(body.ts) && (body.ts as number) >= 0;
}

export const verifyRequest: typeof Ports.verifyRequest = async (req, env, now) => {
  const headers = authHeaders(req);
  if (!headers || !BOT_ID_PATTERN.test(headers.bot)) return unauthorized();
  const registry = loadRegistry(env);
  const from = registry.bots.find(bot => bot.id === headers.bot && bot.enabled);
  if (!from) return unauthorized();

  const parsed = await readBody(req, 65536);
  if (!parsed || !object(parsed.body) || typeof parsed.body.to !== "string") return unauthorized();
  const body = parsed.body;
  // Only use the untrusted recipient to locate credentials before authentication.
  const to = registry.bots.find(bot => bot.id === body.to && bot.enabled);
  const pair = findPair(registry, from.id, parsed.body.to);
  if (!to || !pair || Math.abs(now - headers.ts) > 300) return unauthorized();
  const secret = env[pair.hmac_secret];
  if (typeof secret !== "string" || secret.length === 0) return unauthorized();

  const bodySha = await sha256Hex(parsed.bytes);
  const expected = await hmacSha256Hex(secret, canonicalString(headers.timestamp, req.method, new URL(req.url).pathname, bodySha));
  if (!timingSafeEqualHex(headers.signature, expected)
    || parsed.body.from !== headers.bot || parsed.body.ts !== headers.ts) return unauthorized();
  if (!jsonContentType(req) || !validEnvelope(parsed.body)) return badRequest();
  return { ok: true, envelope: parsed.body, pair, from, to, body_sha256: bodySha, size: parsed.bytes.byteLength };
};

export async function verifyAdmin(req: Request, env: Env, now: number): Promise<{ ok: true; bot: BotId | null } | VerifyErr> {
  const headers = authHeaders(req);
  if (!headers || headers.bot !== "admin") return unauthorized();
  const parsed = await readBody(req, 1024);
  if (!parsed || Math.abs(now - headers.ts) > 300) return unauthorized();
  if (typeof env.ADMIN_HMAC !== "string" || env.ADMIN_HMAC.length === 0) return unauthorized();
  const bodySha = await sha256Hex(parsed.bytes);
  const expected = await hmacSha256Hex(env.ADMIN_HMAC, canonicalString(headers.timestamp, req.method, new URL(req.url).pathname, bodySha));
  if (!timingSafeEqualHex(headers.signature, expected)) return unauthorized();
  if (!jsonContentType(req) || !object(parsed.body)
    || Object.keys(parsed.body).length !== 1 || !Object.hasOwn(parsed.body, "bot")) return badRequest();
  const bot = parsed.body.bot;
  if (bot === null) return { ok: true, bot: null };
  if (typeof bot !== "string" || !BOT_ID_PATTERN.test(bot)
    || !loadRegistry(env).bots.some(registered => registered.id === bot)) return badRequest();
  return { ok: true, bot: bot as BotId };
}
