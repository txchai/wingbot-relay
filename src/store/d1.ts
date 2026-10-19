import type { BotId, MessageRow } from "../types";
import type { Store } from "../ports";

const MAX_ATTEMPTS = 3;
const RETRY_LEASE_S = 300;
const RATE_WINDOW_S = 60;
const RATE_RETENTION_S = 3600;
const MESSAGE_RETENTION_S = 7 * 86400;
const AUDIT_RETENTION_S = 30 * 86400;
const DETAIL_MAX = 64;

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function makeStore(db: D1Database): Store & Required<Pick<Store, "claimRetry">> {
  const insertMessage = async (m: MessageRow): Promise<boolean> => {
    const result = await db
      .prepare(
        `INSERT INTO messages (id, pair, from_bot, to_bot, kind, reply_to, body_sha256, size,
           status, attempts, next_attempt_at, created_at, updated_at, last_status_code, envelope_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(
        m.id,
        m.pair,
        m.from_bot,
        m.to_bot,
        m.kind,
        m.reply_to,
        m.body_sha256,
        m.size,
        m.status,
        m.attempts,
        m.next_attempt_at,
        m.created_at,
        m.updated_at,
        m.last_status_code,
        m.envelope_json,
      )
      .run();
    return result.meta.changes === 1;
  };

  return {
    claimId: insertMessage,
    insertMessage,

    async recordAttempt(messageId, attempt, result) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO attempts (message_id, attempt, http_status, error, started_at, duration_ms)
             SELECT ?, ?, ?, ?, ?, ? FROM messages
             WHERE id = ? AND status != 'delivered' AND attempts = ?`,
          )
          .bind(
            messageId,
            attempt,
            result.http_status,
            result.error,
            result.started_at,
            result.duration_ms,
            messageId,
            attempt - 1,
          ),
        db
          .prepare(
            `UPDATE messages SET attempts = ?, last_status_code = ?, updated_at = ?
             WHERE id = ? AND status != 'delivered' AND attempts = ?`,
          )
          .bind(
            attempt,
            result.http_status,
            result.started_at + Math.floor(result.duration_ms / 1000),
            messageId,
            attempt - 1,
          ),
      ]);
    },

    async markStatus(messageId, status, now, nextAttemptAt, lastStatusCode) {
      await db
        .prepare(
          `UPDATE messages SET status = ?, updated_at = ?, next_attempt_at = ?, last_status_code = ?
           WHERE id = ? AND status != 'delivered'`,
        )
        .bind(status, now, nextAttemptAt, lastStatusCode, messageId)
        .run();
    },

    async dueForRetry(now, limit) {
      const { results } = await db
        .prepare(
          `SELECT * FROM messages
           WHERE status = 'queued' AND next_attempt_at <= ? AND attempts < ?
             AND NOT EXISTS (
               SELECT 1 FROM settings
               WHERE value = '1' AND key IN ('paused', 'paused:' || messages.to_bot)
             )
           ORDER BY next_attempt_at LIMIT ?`,
        )
        .bind(now, MAX_ATTEMPTS, limit)
        .all<MessageRow>();
      return results;
    },

    async failRetry(message, now) {
      // Match the selected lease deadline as well as its attempt version: a
      // concurrent claim changes the deadline without incrementing attempts.
      const owned = "id = ? AND status = 'queued' AND attempts = ? AND next_attempt_at = ? AND next_attempt_at <= ?";
      const owner = [message.id, message.attempts, message.next_attempt_at, now];
      await db.batch([
        db.prepare(
          `INSERT INTO audit (at, event, message_id, from_bot, to_bot, kind, body_sha256, detail)
           SELECT ?, 'route_revoked', id, from_bot, to_bot, kind, body_sha256, 'route_revoked'
           FROM messages WHERE ${owned}`,
        ).bind(now, ...owner),
        // Update last so both statements check the same ownership atomically.
        db.prepare(
          `UPDATE messages SET status = 'failed', updated_at = ?, next_attempt_at = NULL WHERE ${owned}`,
        ).bind(now, ...owner),
      ]);
    },

    async claimRetry(messageId, attempts, now) {
      const leaseUntil = now + RETRY_LEASE_S;
      const claimed = await db.prepare(
        `UPDATE messages SET next_attempt_at = ?, updated_at = ?
         WHERE id = ? AND status = 'queued' AND attempts = ? AND attempts < ? AND next_attempt_at <= ?
           AND NOT EXISTS (
             SELECT 1 FROM settings
             WHERE value = '1' AND key IN ('paused', 'paused:' || messages.to_bot)
           )`,
      ).bind(leaseUntil, now, messageId, attempts, MAX_ATTEMPTS, now).run();
      if (claimed.meta.changes !== 1) return null;

      // The version plus lease deadline fences completion after a reclaim,
      // even when the replacement fails and leaves the message queued.
      const owned = "id = ? AND status = 'queued' AND attempts = ? AND next_attempt_at = ?";
      const owner = [messageId, attempts, leaseUntil];
      return {
        async complete(result) {
          const attempt = attempts + 1;
          const status = result.ok ? "delivered" : attempt >= MAX_ATTEMPTS ? "failed" : "queued";
          const statements = [db.prepare(
            `INSERT INTO attempts (message_id, attempt, http_status, error, started_at, duration_ms)
             SELECT id, ?, ?, ?, ?, ? FROM messages WHERE ${owned}`,
          ).bind(attempt, result.http_status, result.error, result.started_at, result.duration_ms, ...owner)];
          if (status === "failed") {
            statements.push(db.prepare(
              `INSERT INTO audit (at, event, message_id, from_bot, to_bot, kind, body_sha256, detail)
               SELECT ?, 'failed', id, from_bot, to_bot, kind, body_sha256, ? FROM messages WHERE ${owned}`,
            ).bind(now, result.error === null ? null : result.error.slice(0, DETAIL_MAX), ...owner));
          }
          // Update last so every statement checks the same lease within D1's
          // atomic batch; no stale attempt or failure audit can be appended.
          statements.push(db.prepare(
            `UPDATE messages SET attempts = ?, status = ?, updated_at = ?, next_attempt_at = ?, last_status_code = ?
             WHERE ${owned}`,
          ).bind(attempt, status, now, status === "queued" ? now + 60 * attempt : null, result.http_status, ...owner));
          await db.batch(statements);
        },
      };
    },

    async isPaused(botId?: BotId) {
      const keys = botId ? ["paused", `paused:${botId}`] : ["paused"];
      const row = await db
        .prepare(
          `SELECT 1 FROM settings WHERE key IN (${keys.map(() => "?").join(", ")})
           AND value = '1' LIMIT 1`,
        )
        .bind(...keys)
        .first();
      return row !== null;
    },

    async setPaused(botId, paused) {
      await db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(botId ? `paused:${botId}` : "paused", paused ? "1" : "0", nowSeconds())
        .run();
    },

    async hitRateLimit(bot, limit, now) {
      const windowStart = now - (now % RATE_WINDOW_S);
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (bot, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(bot, window_start) DO UPDATE SET count = count + 1
           RETURNING count`,
        )
        .bind(bot, windowStart)
        .first<{ count: number }>();
      const count = row?.count ?? 1;
      // First hit of a new window: prune this bot's stale windows (at most once a minute).
      if (count === 1) {
        await db
          .prepare(`DELETE FROM rate_limits WHERE bot = ? AND window_start < ?`)
          .bind(bot, now - RATE_RETENTION_S)
          .run();
      }
      return count > limit;
    },

    async audit(e) {
      await db
        .prepare(
          `INSERT INTO audit (at, event, message_id, from_bot, to_bot, kind, body_sha256, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          e.at,
          e.event,
          e.message_id,
          e.from_bot,
          e.to_bot,
          e.kind,
          e.body_sha256,
          e.detail === null ? null : e.detail.slice(0, DETAIL_MAX),
        )
        .run();
    },

    async purgeOld(now) {
      const cutoff = now - MESSAGE_RETENTION_S;
      await db.batch([
        db
          .prepare(
            `DELETE FROM attempts WHERE message_id IN (
               SELECT id FROM messages
               WHERE status IN ('delivered', 'failed') AND updated_at < ?)`,
          )
          .bind(cutoff),
        db
          .prepare(
            `DELETE FROM messages WHERE status IN ('delivered', 'failed') AND updated_at < ?`,
          )
          .bind(cutoff),
        db.prepare(`DELETE FROM audit WHERE at < ?`).bind(now - AUDIT_RETENTION_S),
      ]);
    },
  };
}
