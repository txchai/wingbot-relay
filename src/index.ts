import { deliver } from "./deliver";
import { loadRegistry } from "./registry";
import { makeStore } from "./store/d1";
import { runSweep as sweep } from "./sweep";
import { verifyAdmin, verifyRequest } from "./verify";
import type { AuditEvent, Env, MessageRow, VerifyOk } from "./types";

function auditEvent(now: number, event: string, verified?: VerifyOk, detail: string | null = null): AuditEvent {
  return {
    at: now, event, message_id: verified?.envelope.id ?? null,
    from_bot: verified?.from.id ?? null, to_bot: verified?.to.id ?? null,
    kind: verified?.envelope.kind ?? null, body_sha256: verified?.body_sha256 ?? null, detail,
  };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function handleRequest(req: Request, env: Env, now: number): Promise<Response> {
  try {
    return await routeRequest(req, env, now);
  } catch (error) {
    // Log only a fixed error class; messages, stacks and caller-controlled names
    // can contain credentials or payloads and must never be copied into logs.
    const errorClass = error instanceof TypeError ? "TypeError"
      : error instanceof SyntaxError ? "SyntaxError" : error instanceof Error ? "Error" : "Unknown";
    console.error(JSON.stringify({ event: "internal_error", error_class: errorClass }));
    return json({ error: "internal_error" }, 500);
  }
}

async function routeRequest(req: Request, env: Env, now: number): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method !== "POST" || url.search !== "" || !["/v1/messages", "/v1/admin/pause", "/v1/admin/resume"].includes(path)) {
    return json({ error: "not_found" }, 404);
  }
  // Known routes fail closed for invalid configuration, including global admin.
  loadRegistry(env);
  const store = makeStore(env.DB);
  if (path !== "/v1/messages") {
    const verified = await verifyAdmin(req, env, now);
    if (!verified.ok) {
      if (verified.status === 400) await store.audit(auditEvent(now, "rejected", undefined, verified.error));
      return json({ error: verified.error }, verified.status);
    }
    const paused = path === "/v1/admin/pause";
    await store.setPaused(verified.bot, paused);
    await store.audit({
      ...auditEvent(now, paused ? "admin_pause" : "admin_resume", undefined, verified.bot === null ? "global" : "bot"),
      to_bot: verified.bot,
    });
    return json({ key: verified.bot === null ? "paused" : `paused:${verified.bot}`, value: paused ? "1" : "0" });
  }

  const verified = await verifyRequest(req, env, now);
  if (!verified.ok) {
    if (verified.status === 400) await store.audit(auditEvent(now, "rejected", undefined, verified.error));
    return json({ error: verified.error }, verified.status);
  }
  const { envelope, from, to, pair, body_sha256, size } = verified;
  if (await store.hitRateLimit(from.id, from.rate_limit_per_min, now)) {
    await store.audit(auditEvent(now, "rate_limited", verified, "rate_limited"));
    return json({ error: "rate_limited" }, 429);
  }
  const paused = await store.isPaused(to.id);
  const row: MessageRow = {
    id: envelope.id, pair: pair.name, from_bot: from.id, to_bot: to.id, kind: envelope.kind,
    reply_to: envelope.reply_to, body_sha256, size, status: "queued", attempts: 0,
    // Reserve the inline attempt's window before the row becomes visible to cron.
    next_attempt_at: paused ? now : now + 60, created_at: now, updated_at: now, last_status_code: null,
    envelope_json: JSON.stringify(envelope),
  };
  if (!await store.insertMessage(row)) {
    await store.audit(auditEvent(now, "duplicate", verified, "duplicate"));
    return json({ error: "duplicate" }, 409);
  }
  await store.audit(auditEvent(now, "accepted", verified));
  if (paused || await store.isPaused(to.id)) {
    // A pause can arrive during insertion/audit; leave skipped work due on resume.
    if (!paused) await store.markStatus(row.id, "queued", now, now, null);
    await store.audit(auditEvent(now, "paused", verified, "paused"));
    return json({ id: envelope.id, status: "queued" }, 202);
  }
  const attempt = row.attempts + 1;
  const result = await deliver(env, envelope, to, { received_at: now, attempt });
  await store.recordAttempt(row.id, attempt, result);
  const status = result.ok ? "delivered" : attempt >= 3 ? "failed" : "queued";
  await store.markStatus(row.id, status, now, status === "queued" ? now + 60 : null, result.http_status);
  return json({ id: envelope.id, status }, 202);
}

export async function runSweep(env: Env, now: number): Promise<void> {
  await sweep(env, now);
}

export default {
  fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    return handleRequest(req, env, Math.floor(Date.now() / 1000));
  },
  scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(runSweep(env, Math.floor(Date.now() / 1000)));
  },
} satisfies ExportedHandler<Env>;
