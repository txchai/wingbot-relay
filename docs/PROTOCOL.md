# Wingbot Protocol Specification (v1)

*Status: Authoritative Frozen Contract*

Wingbot is an authenticated, replay-protected, multi-tenant HTTP relay connecting AI bots ("Grok Bots") living in different accounts. This document defines the wire protocol, signing scheme, envelope structure, status codes, webhook delivery format, retry mechanics, and kill-switch controls.

---

## 1. Identifiers & Registry Model

### Bot Identifiers
Bot IDs follow the format `<account>:<bot>` in lowercase:
- Regular expression: `^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$`
- Examples: `personal:wingbot`, `work:wingbot`, `team-alpha:agent-1`

### Registry Structure
The relay configuration is defined in JSON (`registry.json` or Worker environment variable `REGISTRY_JSON`):

```json
{
  "version": 1,
  "bots": [
    {
      "id": "personal:wingbot",
      "webhook_url": "https://api2.cursor.sh/automations/webhook/<id>",
      "webhook_key_secret": "WEBHOOK_KEY_PERSONAL_WINGBOT",
      "rate_limit_per_min": 30,
      "enabled": true
    },
    {
      "id": "work:wingbot",
      "webhook_url": "https://api2.cursor.sh/automations/webhook/<id>",
      "webhook_key_secret": "WEBHOOK_KEY_WORK_WINGBOT",
      "rate_limit_per_min": 30,
      "enabled": true
    }
  ],
  "pairs": [
    {
      "name": "personal-work",
      "bots": ["personal:wingbot", "work:wingbot"],
      "hmac_secret": "HMAC_PAIR_PERSONAL_WORK",
      "enabled": true
    }
  ]
}
```

### Shared Secrets
- **Per-Pair Secret**: Each pair shares one HMAC-SHA256 secret. Communication is bidirectional. Both bots and the relay hold this secret.
- **Webhook Sender Key**: Each target bot has an automation key stored as a Cloudflare Worker secret (`webhook_key_secret`).
- Secret values are never stored in `registry.json`, code, logs, or database rows.

---

## 2. Inbound Request: Bot -> Relay

### Endpoint
- Method: `POST`
- Path: `/v1/messages`
- Content-Type: `application/json`
- Max Body Size: 64 KiB (65,536 bytes)

### Headers
Every request must include:
- `X-Wingbot-Bot`: Sender bot identifier (must match `envelope.from`).
- `X-Wingbot-Timestamp`: Unix epoch time in seconds (`date +%s`), must match `envelope.ts`.
- `X-Wingbot-Signature`: `v1=<hex_hmac>` where `hex_hmac` is the lowercase hexadecimal HMAC-SHA256.

### Envelope Schema (v1)
```json
{
  "v": 1,
  "id": "<uuid v4>",
  "kind": "task" | "result",
  "from": "<sender bot id>",
  "to": "<target bot id>",
  "task": "<task string, max 16 KiB>",
  "context": {},
  "reply_to": "<message id or null>",
  "ts": <unix epoch seconds>
}
```

#### Envelope Rules
1. `v`: Must be the integer `1`.
2. `id`: Must be a lowercase UUID v4 string.
3. `kind`: Must be either `"task"` or `"result"`.
4. `from`: Must match `X-Wingbot-Bot` header.
5. `to`: Target bot identifier; must be an enabled pair with `from`.
6. `task`: String payload up to 16 KiB (16,384 bytes).
7. `context`: Required JSON object for routing/metadata (send `{}` when empty).
8. `reply_to`: Required key. Lowercase UUID v4 of the original task when `kind="result"`; `null` for a new task.

All nine keys are required and unknown keys are rejected with an authenticated 400. `id`/`reply_to` must be lowercase (no case-insensitive matching).
9. `ts`: Unix epoch seconds; must match `X-Wingbot-Timestamp`.

---

## 3. Canonical String & HMAC-SHA256 Signing

To prevent tampering and replay, requests are signed over a deterministic canonical string.

### Canonical String Format
UTF-8 text, separated by newline characters (`\n`), with **no trailing newline**:

```
wingbot-v1
<timestamp>
POST
<path>
<body_sha256>
```

- `<timestamp>`: Value from `X-Wingbot-Timestamp` header.
- `<path>`: The HTTP request path (`/v1/messages` for envelopes; `/v1/admin/pause` or `/v1/admin/resume` for admin).
- `<body_sha256>`: Lowercase 64-character hexadecimal SHA-256 hash of the **exact raw request body bytes**.

### HMAC Computation & Key Rule
```
Signature = HMAC-SHA256(secret, canonical_string)
```

> **KEY RULE**: The HMAC key is the secret string's **raw UTF-8 bytes** (not hex-decoded bytes).
> In Node.js: `crypto.createHmac('sha256', secretString)`
> In OpenSSL: `openssl dgst -sha256 -hmac "$SECRET"`

The computed signature is prefixed with `v1=` and placed in the header:
```
X-Wingbot-Signature: v1=<lowercase_hex_signature>
```

### Worked Verification Example

#### Inputs
- **Secret**: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
- **Timestamp**: `1775883600`
- **Path**: `/v1/messages`
- **Raw Body**:
  ```json
  {"v":1,"id":"d9428888-122b-42d7-b3e1-3e42f63e62f0","kind":"task","from":"personal:wingbot","to":"work:wingbot","task":"Summarize the latest deployment report","context":{},"reply_to":null,"ts":1775883600}
  ```

#### Intermediate Hashes
- **Body SHA-256**:
  `056dbe75726398c8b8c6cf2b5eef979de0e56bb1fea0b16a43bd192d8dfe4d18`
- **Canonical String** (5 lines):
  ```
  wingbot-v1
  1775883600
  POST
  /v1/messages
  056dbe75726398c8b8c6cf2b5eef979de0e56bb1fea0b16a43bd192d8dfe4d18
  ```

#### Generated Signature
- **Header Value**:
  `X-Wingbot-Signature: v1=12c5f4ab48eee167f64373aa17b1c2b85fb72a1a2a92a03c64aac39e7d386cdc`

---

## 4. Verification Order & Response Status Codes

To prevent enumeration and timing side-channels, the relay evaluates checks in strict priority order and uses **generic error bodies**:

| Priority | Check | Status Code | Body | Reason / Notes |
|---|---|---|---|---|
| 1 | Route & Method | **404 Not Found** | `{"error":"not_found"}` | Non-existent path or non-POST method. |
| 2 | Authentication & Integrity | **401 Unauthorized** | `{"error":"unauthorized"}` | Missing headers, invalid format, unknown/disabled bot, body > 64 KiB, unparseable JSON, no enabled pair, clock skew \|now - ts\| > 300 s, bad signature, `from` != header, `ts` mismatch. Constant-time signature check. |
| 3 | Schema Validation | **400 Bad Request** | `{"error":"bad_request"}` | Missing required fields, `task` > 16 KiB, invalid `kind`, `kind=result` without `reply_to`. Checked only after signature is validated. |
| 4 | Rate Limiting | **429 Too Many Requests** | `{"error":"rate_limited"}` | Exceeded sending bot's per-minute quota (D1 window). |
| 5 | Replay Detection | **409 Conflict** | `{"error":"duplicate"}` | Message ID already exists in D1 database (`PRIMARY KEY` collision). |
| 6 | Acceptance | **202 Accepted** | `{"id":"...","status":"delivered"}` or `{"id":"...","status":"queued"}` | Delivered if inline webhook got 200; queued if paused by kill switch or inline attempt failed. |

---

## 5. Webhook Delivery: Relay -> Target Bot

When forwarding an envelope to the target bot's webhook:
- **HTTP Method**: `POST`
- **Target URL**: Configured `webhook_url` for target bot
- **Timeout**: 8 seconds
- **Headers**:
  - `Content-Type: application/json`
  - `Authorization: Bearer <webhook_key>`
  - `X-Automation-Key: <webhook_key>`
- **Payload Structure**:
  ```json
  {
    "wingbot": 1,
    "envelope": {
      "v": 1,
      "id": "d9428888-122b-42d7-b3e1-3e42f63e62f0",
      "kind": "task",
      "from": "personal:wingbot",
      "to": "work:wingbot",
      "task": "Summarize the latest deployment report",
      "context": {},
      "reply_to": null,
      "ts": 1775883600
    },
    "relay": {
      "received_at": 1775883601,
      "attempt": 1,
      "verified": true
    }
  }
  ```
- **Success Criteria**: HTTP status code exactly `200`.

---

## 6. Delivery Retries & Cron Sweep

- **Attempt 1**: Executed inline synchronously during the inbound request.
- **Retries**: If attempt 1 fails or if the target bot is paused, the message is stored with status `queued`.
- **Cron Sweep**: A Cloudflare Cron Trigger running every minute (`* * * * *`) scans D1 for messages due for retry:
  - Attempt 2: Scheduled at >= 60 seconds after attempt 1.
  - Attempt 3: Scheduled at >= 120 seconds after attempt 2.
  - Max Attempts: 3 total. If attempt 3 fails, status transitions to `failed`.
  - Batch Limit: Max 20 messages per sweep run to stay well within free-tier execution limits.
- **Data-at-Rest Retention**: Message envelopes are retained in D1 for redelivery and automatically purged 7 days after reaching terminal status (`delivered` or `failed`).

---

## 7. Kill Switch & Admin Controls

Wingbot provides an emergency kill switch to pause outbound deliveries without tearing down infrastructure.

### Storage Keys (D1 `settings` table)
- Global kill switch: `key = "paused"`, `value = "1"` (paused) or `"0"` (active).
- Per-bot kill switch: `key = "paused:<bot_id>"`, `value = "1"` or `"0"`.

### Behavior Under Pause
- Inbound messages from authorized bots are still accepted and stored as `queued` (HTTP 202).
- Outbound delivery attempts are deferred.
- Once resumed, the Cron sweep picks up queued messages and delivers them.

### Admin Endpoints
- `POST /v1/admin/pause`
- `POST /v1/admin/resume`
- Request body: `{"bot": "<id>"}` (per-bot) or `{"bot": null}` (global).
- Signed using the standard Wingbot canonical signing scheme:
  - `X-Wingbot-Bot`: `admin`
  - Canonical path: `/v1/admin/pause` or `/v1/admin/resume`
  - Secret: `ADMIN_HMAC` (Worker secret)
  - Generic 401 on unauthorized or invalid signature.
