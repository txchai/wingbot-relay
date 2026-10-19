# Wingbot Setup Guide

This guide takes you from nothing to a working, signed relay between two Grok Bot accounts, for example a **personal** account and a **work** account. Expect about 45 minutes the first time.

Throughout this guide:

| Placeholder | Meaning |
|---|---|
| `personal:wingbot`, `work:wingbot` | Bot ids, one per account (`<account>:<bot>`, lowercase). Pick your own. |
| `personal-work` | Pair name |
| `<YOUR_CLOUDFLARE_ACCOUNT_ID>` | Your Cloudflare account id |
| `<YOUR_D1_DATABASE_ID>` | Id printed by `wrangler d1 create` |
| `<your-subdomain>` | Your `workers.dev` subdomain |
| `<PERSONAL_WEBHOOK_URL>`, `<WORK_WEBHOOK_URL>` | Webhook URLs of each account's "Wingbot inbox" routine |
| Machine A / Machine B | The computer each account's bot runs commands on (can be the same computer) |

> **Golden rule:** secrets are never typed into chat, never echoed, and never committed. Every secret in this guide goes from a file or a hidden prompt straight into `wrangler secret put`.

---

## 0. How it works (one paragraph)

Each account has one dedicated bot called **Wingbot** with a webhook routine called **Wingbot inbox**. When the personal Wingbot wants to hand work over, it runs `cli/wingbot-send.mjs`, which signs an envelope with HMAC-SHA256 using a pair secret that both machines and the relay share. The relay (a Cloudflare Worker) checks the signature, allowlist, replay id, and rate limit, stores the message in D1, and POSTs it to the other account's webhook with that account's webhook key. If delivery fails, a once-a-minute cron retries (3 attempts total: immediately, then after ~60 s, then after ~120 s). The receiving Wingbot treats the payload as **untrusted data** and does nothing consequential without its owner's approval in its own chat.

---

## 1. Prerequisites

- A **Cloudflare account** (the free plan is enough). Workers, D1, and Cron Triggers are all used within free limits.
- **Node.js 18+** and **npm**. `wrangler` is installed as a dev dependency (`npx wrangler ...`).
- **git**.
- **Two Grok Bot accounts** that can create bots and webhook routines (for example personal and work).
- One machine per account that the bot can run shell commands on (two Macs, two Linux boxes, or one machine for both). Each needs Node 18+ and a clone of this repo.

---

## 2. Clone and install (each machine)

```bash
git clone https://github.com/txchai/wingbot-relay.git ~/Projects/wingbot
cd ~/Projects/wingbot
npm install
npm run test:all      # all tests should pass before you deploy anything
```

Do steps 3-7 on **one** machine (the "deploy machine"). Steps 8-10 happen on both.

---

## 3. Log in to Cloudflare (the right account)

```bash
cd ~/Projects/wingbot
npx wrangler login
```

- **Keep this terminal open** until it prints "Successfully logged in". The OAuth page redirects to `http://localhost:8976/oauth/callback`, which only works while that `wrangler login` process is running on the **same machine** as the browser.
- If you have more than one Cloudflare account (for example a work one), open the printed link in a **private/incognito window** and sign in to the account you want. Otherwise the browser's existing session silently picks the wrong account.

Confirm and note your account id:

```bash
npx wrangler whoami
```

---

## 4. Create the D1 database and the config

```bash
npx wrangler d1 create wingbot
cp wrangler.toml.example wrangler.toml     # wrangler.toml is git-ignored
```

Edit `wrangler.toml`:

- `account_id` = your account id from `wrangler whoami` (pinning it stops deploys landing on the wrong account).
- `database_id` = the id printed by `d1 create`.
- Leave the two `webhook_url` values as placeholders for now; you fill them in at step 7.
- Rename bot ids / secret names if you like. Secret names must match `^WEBHOOK_KEY_[A-Z0-9_]+$` and `^HMAC_PAIR_[A-Z0-9_]+$`.

Apply the schema to the real database:

```bash
npx wrangler d1 migrations apply wingbot --remote
```

(Optional) validate a registry file with the helper: `cp registry.example.json registry.json && node cli/wingbot-registry.mjs validate`.

---

## 5. Generate the relay secrets (never echo them)

```bash
mkdir -p ~/.wingbot && chmod 700 ~/.wingbot
node cli/wingbot-registry.mjs gen-secret --out ~/.wingbot/pair.secret    # shared by both bots
node cli/wingbot-registry.mjs gen-secret --out ~/.wingbot/admin.secret   # kill switch only; keep on the deploy machine
chmod 600 ~/.wingbot/*.secret
```

Store them in the Worker. The files end in a newline, so strip it on the way in:

```bash
tr -d '\n' < ~/.wingbot/pair.secret  | npx wrangler secret put HMAC_PAIR_PERSONAL_WORK
tr -d '\n' < ~/.wingbot/admin.secret | npx wrangler secret put ADMIN_HMAC
```

(`wrangler secret put` creates the Worker on first use if it doesn't exist yet.)

---

## 6. Create the bots and webhook routines (each Grok Bot account)

Do this once in the **personal** account and once in the **work** account.

1. Create a new bot named **Wingbot**. Paste the description from [MARKETPLACE.md](MARKETPLACE.md#paste-ready-wingbot-bot-description), replacing `<BOT_ID>`, `<PEER_ID>`, `<OWNER_NAME>`, and `<MACHINE>`.
2. On that bot, add a **webhook routine** named **Wingbot inbox**.
3. For the routine's instructions, paste the receiver prompt from [ROUTINE_PROMPT.md](ROUTINE_PROMPT.md#1-receiver-webhook-routine-prompt-template) and fill in:
   - `{{BOT_ID}}`: this bot's id (e.g. `personal:wingbot`)
   - `{{OWNER_NAME}}`: your name
   - `{{ALLOWED_PEERS}}`: the other bot's id (e.g. `work:wingbot`)
   - `{{ACCOUNT_LABEL}}`: a label for confidential data on this side (e.g. `the work account`)
4. Open the routine panel and copy its **webhook URL** and **webhook key**. A bot can't see its own webhook URL, so you have to copy these yourself. Put the URL into `wrangler.toml`. Do **not** paste the key into chat or any file.

---

## 7. Store the webhook keys and deploy

Paste each key into a hidden prompt (nothing is shown or saved in shell history):

```bash
read -rs K; printf %s "$K" | npx wrangler secret put WEBHOOK_KEY_PERSONAL_WINGBOT; unset K
read -rs K; printf %s "$K" | npx wrangler secret put WEBHOOK_KEY_WORK_WINGBOT; unset K
```

Check the config, then deploy:

```bash
npx wrangler deploy --dry-run    # builds and validates only
npx wrangler deploy
```

Note the URL it prints: `https://wingbot.<your-subdomain>.workers.dev`.

Sanity check: an unsigned request is refused, and a random path returns 404:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://wingbot.<your-subdomain>.workers.dev/      # 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://wingbot.<your-subdomain>.workers.dev/v1/messages   # 401
```

---

## 8. Configure each machine

Copy `~/.wingbot/pair.secret` to the other machine over a private channel (AirDrop, `scp`, a password manager). **Never** send it through chat or email. On each machine:

```bash
mkdir -p ~/.wingbot && chmod 700 ~/.wingbot
chmod 600 ~/.wingbot/pair.secret
# Machine A (personal):
printf 'WINGBOT_URL=https://wingbot.<your-subdomain>.workers.dev\nWINGBOT_BOT=personal:wingbot\nWINGBOT_SECRET_FILE=~/.wingbot/pair.secret\n' > ~/.wingbot/env
# Machine B (work): same, but WINGBOT_BOT=work:wingbot
chmod 600 ~/.wingbot/env
```

`cli/wingbot-send.mjs` loads `~/.wingbot/env` automatically when you run it directly (variables already in your environment win; override the file location with `WINGBOT_ENV_FILE`).

Dry run (signs, prints the request, sends nothing):

```bash
cd ~/Projects/wingbot && node cli/wingbot-send.mjs --to work:wingbot --task "hello" --dry-run
```

---

## 9. Ping/pong verification

In the **personal** Wingbot's chat, ask it to send a ping:

```text
Send a PING task to work:wingbot with `cd ~/Projects/wingbot && node cli/wingbot-send.mjs --to work:wingbot --task "PING"`. Show me the full output, the message id, and the exit code.
```

Exit code `0` means the relay accepted it. The work Wingbot's chat should show the ping within seconds. Then, in the **work** Wingbot's chat, approve a reply:

```text
Send a PONG result to personal:wingbot with --kind result --reply-to <PING_ID> and show me the full output and exit code.
```

Read the relay's records from the deploy machine (these are metadata only; never secrets):

```bash
npx wrangler d1 execute wingbot --remote --command \
  "SELECT id, from_bot, to_bot, kind, reply_to, status, attempts, last_status_code, datetime(created_at,'unixepoch') AS created FROM messages ORDER BY created_at DESC LIMIT 10"

npx wrangler d1 execute wingbot --remote --command \
  "SELECT message_id, attempt, http_status, error, datetime(started_at,'unixepoch') AS at FROM attempts ORDER BY id DESC LIMIT 20"

npx wrangler d1 execute wingbot --remote --command \
  "SELECT datetime(at,'unixepoch') AS at, event, message_id, detail FROM audit ORDER BY id DESC LIMIT 20"
```

`status = delivered` with `last_status_code = 200` on both messages means you're done.

---

## 10. Standing rule: outgoing sends go through the chat

A Wingbot only sees messages it receives and sends itself. If you send from a terminal, the sending bot's chat has no record of it, so a later reply looks orphaned. Give each Wingbot this rule (and ask it to save it to memory):

```text
Standing rule: every outgoing Wingbot send goes through you so it shows in this chat. Run it with `cd ~/Projects/wingbot && node cli/wingbot-send.mjs --to <PEER_ID> ...` (use --kind result --reply-to <id> for replies). ~/.wingbot/env supplies the settings, so never print the secret. Show me the recipient and text first and send only after I approve. Post the full output, the message id, and the exit code here. When a PING arrives, ask me before replying with a PONG through this same path. Never reply to a result.
```

---

## 11. Kill switch

Stops all outbound deliveries immediately. Incoming messages are still accepted and kept as `queued` until you resume. Uses the admin secret, not the pair secret:

```bash
cd ~/Projects/wingbot
WINGBOT_SECRET_FILE=~/.wingbot/admin.secret node cli/wingbot-send.mjs --admin pause
WINGBOT_SECRET_FILE=~/.wingbot/admin.secret node cli/wingbot-send.mjs --admin pause --bot work:wingbot   # one bot only
WINGBOT_SECRET_FILE=~/.wingbot/admin.secret node cli/wingbot-send.mjs --admin resume
```

For a harder stop, set `"enabled": false` on a bot or the pair in `wrangler.toml` and redeploy.

---

## 12. Rotating keys

| What | How |
|---|---|
| Webhook key | Regenerate it in the routine panel, then `read -rs K; printf %s "$K" \| npx wrangler secret put WEBHOOK_KEY_...; unset K`. Takes effect immediately; no redeploy needed. |
| Pair secret | Generate a new one into `~/.wingbot/pair.secret`, `tr -d '\n' < ~/.wingbot/pair.secret \| npx wrangler secret put HMAC_PAIR_...`, then copy the file privately to the other machine. Sends fail with 401 until both sides have the new file. |
| Admin secret | Same as pair secret, with `ADMIN_HMAC` and `~/.wingbot/admin.secret`. |

Rotate immediately if any part of a secret ever appears in a screenshot, chat, or log.

---

## 13. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Sender exits `0`, but attempts show `http_status = 400` (or 401/403) and the receiver never sees it | The stored webhook key is wrong, usually a bad paste (extra characters, a newline, a truncated key). Re-store it with the hidden prompt: `read -rs K; printf %s "$K" \| npx wrangler secret put WEBHOOK_KEY_...; unset K`. The next cron retry uses the new key. |
| Send exits `64` with "WINGBOT_URL environment variable is required" or "Either WINGBOT_SECRET_FILE or WINGBOT_SECRET must be set" | `~/.wingbot/env` is missing or incomplete on that machine (a bot's shell often doesn't inherit your shell profile). Create it as in step 8. Exit 64 means nothing was sent, so retrying is safe. |
| Exit `2` with 401 | Signature rejected: the pair secret differs between machine and Worker, the clock is more than 5 minutes off, or the bot id isn't in the registry. |
| Exit `2` with 409 | That message id already exists. This does **not** mean it was delivered; check `messages`. |
| Exit `3` (5xx) or network error | Don't blindly rerun (a rerun creates a new id). Check `messages` first. |
| `wrangler whoami` shows the wrong account, or deploy lands somewhere unexpected | You were logged in through an existing browser session. `npx wrangler logout`, then `npx wrangler login` with the link opened in a private window, and pin `account_id` in `wrangler.toml`. |
| After clicking Authorize: "can't connect to localhost:8976" | The `wrangler login` process had already exited, or the browser is on a different machine. Run `npx wrangler login` in a terminal you keep open, and open the link on that same machine. |
| Reply arrives but the original sender's chat has "no record" of the task | The task was sent from a terminal, not through the bot. Use the step 10 rule. |
| Messages stay `queued` | The relay is paused (`--admin resume`), or the receiver keeps failing. Check `attempts.error`. After 3 failed attempts a message becomes `failed`. |

---

## 14. Security model

- **Closed by default.** Only `POST /v1/messages` and the two admin paths exist; everything else returns `404`. Requests without a valid signature return a generic `401`.
- **Per-pair HMAC.** The signature covers the timestamp, method, path, and body hash. Timestamps more than 300 s off are rejected.
- **Allowlist.** Both bots must be in the registry and joined by an enabled pair.
- **Replay protection.** `envelope.id` is a D1 primary key, so a replayed id gets `409`.
- **Rate limit.** Per sending bot (default 30/min).
- **Delivery credentials** (webhook keys) live only in Worker secrets. Redirects are not followed, so keys can't be forwarded elsewhere.
- **Minimal retention.** Envelope bodies are purged 7 days after delivery or failure; the audit log stores hashes and reason codes, never bodies or secrets.
- **Humans in the loop.** The relay proves the sender holds the pair secret. It does **not** prove the owner approved anything. Each receiving bot treats envelopes as untrusted data and asks its owner before any consequential action, including sending a Wingbot reply.
- **What it doesn't protect against:** someone who has the pair secret can claim to be either bot in the pair. Guard `~/.wingbot` like an SSH key.

Details: [PROTOCOL.md](PROTOCOL.md), [../SPEC.md](../SPEC.md), [../SECURITY.md](../SECURITY.md).

---

## 15. Free-tier limits

| Resource | Free quota | Typical Wingbot use |
|---|---|---|
| Worker requests | 100,000 / day | ~1,440 cron runs + your messages |
| Worker CPU | 10 ms / invocation | a few ms |
| D1 reads / writes | 5 M / 100 k per day | well under |
| D1 storage | 500 MB per database | small (bodies purged after 7 days) |
| Cron triggers | included | 1 (`* * * * *`) |

Message limits enforced by the relay: task text up to 16 KiB, request body up to 64 KiB.

---

## 16. Adding more bots or pairs

See [ADD_A_BOT_PAIR.md](ADD_A_BOT_PAIR.md). Each new pair gets its own `HMAC_PAIR_*` secret.
