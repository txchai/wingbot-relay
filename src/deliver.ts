import type * as Ports from "./ports";
import type { DeliveryResult } from "./types";

export const deliver: typeof Ports.deliver = async (env, envelope, bot, relay) => {
  const started = Date.now();
  const result = (ok: boolean, http_status: number | null, error: string | null): DeliveryResult => ({
    ok, http_status, error, started_at: Math.floor(started / 1000), duration_ms: Math.max(0, Date.now() - started),
  });
  const key = env[bot.webhook_key_secret];
  if (typeof key !== "string" || key.length === 0) return result(false, null, "missing_key");
  try {
    const response = await globalThis.fetch(bot.webhook_url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Automation-Key": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        wingbot: 1,
        envelope,
        relay: { received_at: relay?.received_at ?? Math.floor(started / 1000), attempt: relay?.attempt ?? 1, verified: true },
      }),
      signal: AbortSignal.timeout(8000),
      // A redirect is not a 200 and must not forward credentials to another URL.
      redirect: "manual",
    });
    return result(response.status === 200, response.status, response.status === 200 ? null : "http_error");
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return result(false, null, timeout ? "timeout" : "fetch_error");
  }
};
