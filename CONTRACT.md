# Wingbot frozen contract (orchestrator-owned; SPEC v1 must match this)

## Bots, pairs, registry
- Bot id: `<account>:<bot>` lowercase, regex `^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$` (e.g. `personal:wingbot`, `work:wingbot`).
- Registry = JSON in Worker var `REGISTRY_JSON` (also `registry.json` in repo, see registry.example.json):
  ```json
  { "version": 1,
    "bots": [ { "id": "personal:wingbot", "webhook_url": "https://api2.cursor.sh/automations/webhook/<id>", "webhook_key_secret": "WEBHOOK_KEY_PERSONAL_WINGBOT", "rate_limit_per_min": 30, "enabled": true } ],
    "pairs": [ { "name": "personal-work", "bots": ["personal:wingbot", "work:wingbot"], "hmac_secret": "HMAC_PAIR_PERSONAL_WORK", "enabled": true } ] }
  ```
- One HMAC shared secret PER PAIR (both bots of a pair hold it); pair is bidirectional. Secrets are Worker secrets named by `hmac_secret` / `webhook_key_secret` (values never in registry, code, logs, D1).

## Request bot -> relay
`POST /v1/messages`, `Content-Type: application/json`, body = envelope JSON (raw bytes are what is signed), max 64 KiB.
Headers:
- `X-Wingbot-Bot: <from bot id>`
- `X-Wingbot-Timestamp: <unix seconds>`
- `X-Wingbot-Signature: v1=<lowercase hex HMAC-SHA256(pairSecret, canonical)>`
Canonical string (UTF-8, `\n` separators, no trailing newline):
```
wingbot-v1
<timestamp>
POST
/v1/messages
<lowercase hex sha256(raw body bytes)>
```
Pair is determined by (X-Wingbot-Bot, envelope.to) — relay looks up the enabled pair containing both.

## Envelope v1
```json
{ "v": 1, "id": "<uuid v4>", "kind": "task" | "result", "from": "<bot id>", "to": "<bot id>",
  "task": "<string, <= 16 KiB>", "context": { }, "reply_to": "<message id or null>",
  "ts": <unix seconds, must equal X-Wingbot-Timestamp> }
```
`kind=result` requires `reply_to`. `from` must equal `X-Wingbot-Bot`. `relay_sig` from the draft is dropped (signature lives in header).

## Verification order & responses (bodies generic: never reveal which check failed)
1. Route/method unknown -> 404 `{"error":"not_found"}`
2. Missing headers, bad format, unknown/disabled bot, body > 64 KiB, unparseable JSON, no enabled pair (from,to), stale ts (|now-ts| > 300 s), bad signature, from!=header, ts mismatch -> 401 `{"error":"unauthorized"}` (constant-time compare; signature checked before trusting body fields except to locate pair).
3. Schema invalid (after signature valid) -> 400 `{"error":"bad_request"}`
4. Rate limit (per sending bot, fixed 60 s window, D1 counter) -> 429 `{"error":"rate_limited"}`
5. Replay (id already seen) -> 409 `{"error":"duplicate"}`
6. Accepted: 202 `{"id":"...","status":"delivered"|"queued"}` (delivered if inline attempt got 200; queued if paused or inline failed).

## Delivery
- To target bot webhook: `POST webhook_url`, headers `Authorization: Bearer <key>`, `X-Automation-Key: <key>`, `Content-Type: application/json`; body = JSON `{ "wingbot": 1, "envelope": <envelope>, "relay": { "received_at": <unix s>, "attempt": n, "verified": true } }`. Timeout 8 s; success iff HTTP 200.
- Attempt 1 inline (via ctx.waitUntil is NOT used; do it synchronously so the response says delivered/queued). Retries by Cron `* * * * *` sweep: attempt 2 at >= 60 s, attempt 3 at >= 120 s after the previous; max 3 attempts then status `failed`. Sweep handles max 20 messages per run.
- Kill switch: D1 `settings` key `paused` ('1'/'0') global and `paused:<bot id>` per target bot. When paused, messages are stored `queued` (no attempt counted) and delivered by sweep after resume.
- Admin: `POST /v1/admin/pause` / `/v1/admin/resume` body `{"bot": "<id>"|null}`, signed same scheme with `X-Wingbot-Bot: admin` and secret `ADMIN_HMAC`. Path in canonical string is the admin path. Same generic 401.

## D1 tables (lane B owns exact SQL)
messages(id PK, pair, from_bot, to_bot, kind, reply_to, body_sha256, size, status queued|delivered|failed, attempts, next_attempt_at, created_at, updated_at, last_status_code)
attempts(id autoinc, message_id, attempt, http_status, error, started_at, duration_ms)
audit(id autoinc, at, event, message_id, from_bot, to_bot, kind, body_sha256, detail)  — detail is a short reason code, never secrets/bodies
settings(key PK, value, updated_at)
rate_limits(bot, window_start, count, PK(bot, window_start))
Envelope body needed for retries is stored in `messages.envelope_json` (needed to redeliver; documented as data-at-rest risk; purged 7 days after terminal status by sweep).
Replay = messages.id PRIMARY KEY (INSERT fails -> 409).

## Env (types)
`interface Env { DB: D1Database; REGISTRY_JSON: string; ADMIN_HMAC?: string; [secret: string]: unknown }`
