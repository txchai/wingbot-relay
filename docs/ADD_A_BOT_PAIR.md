# Adding a Bot Pair to Wingbot

This guide walks other teams through connecting two bots across different accounts using Wingbot.

Wingbot uses an **explicit allowlist** model with **per-pair HMAC shared secrets**. Both bots in a pair share a single cryptographic secret, and the Wingbot relay verifies that the sender is authorized to communicate with the recipient before forwarding any message.

---

## Prerequisites

- Access to the Wingbot repository.
- Node.js >= 18 installed locally.
- Cloudflare Wrangler CLI authenticated to the Cloudflare account hosting Wingbot (`npx wrangler whoami`).
- Webhook trigger access on both Grok Bot accounts.

---

## Step 1: Create Webhook Routines for Both Bots

Each bot that can receive tasks or results must have an automation routine triggered by an incoming HTTP webhook.

1. In the target bot's control console, create a new Automation Routine.
2. Select Trigger: **Webhook**.
3. Note the generated Webhook URL:
   `https://api2.cursor.sh/automations/webhook/<webhook-id>`
4. Note the Webhook Sender Key (the automation authorization token).
5. In the routine instructions, copy and paste the security prompt from [ROUTINE_PROMPT.md](ROUTINE_PROMPT.md) to enforce the untrusted payload boundary and consequential actions gating.
6. Repeat this process for the second bot so both bots can receive messages.

---

## Step 2: Register Bots and Pair in `registry.json`

Use the zero-dependency CLI `cli/wingbot-registry.mjs` to register the bots and their communication pair.

### 1. Add Bot A
```bash
node cli/wingbot-registry.mjs add-bot \
  --id "team-alpha:researcher" \
  --webhook-url "https://api2.cursor.sh/automations/webhook/alpha-uuid-123" \
  --rate 30
```

### 2. Add Bot B
```bash
node cli/wingbot-registry.mjs add-bot \
  --id "team-beta:synthesizer" \
  --webhook-url "https://api2.cursor.sh/automations/webhook/beta-uuid-456" \
  --rate 30
```

### 3. Add the Pair
Pairs are bidirectional. Registering the pair allows `team-alpha:researcher` and `team-beta:synthesizer` to send messages to each other.
```bash
node cli/wingbot-registry.mjs add-pair \
  --name "alpha-beta" \
  --a "team-alpha:researcher" \
  --b "team-beta:synthesizer"
```

### 4. Validate the Registry
Ensure that the registry configuration is well-formed:
```bash
node cli/wingbot-registry.mjs validate
```
Expected output:
```
Validation PASSED: registry.json is valid (2 bots, 1 pairs).
```

---

## Step 3: Generate and Distribute the Pair Secret

Each bot pair shares a unique 256-bit cryptographic secret (64 lowercase hexadecimal characters).

### 1. Generate the Secret File
Generate the secret and write it directly to a secure file with restricted permissions (`0600`):
```bash
mkdir -p ~/.wingbot
chmod 700 ~/.wingbot
node cli/wingbot-registry.mjs gen-secret --out ~/.wingbot/alpha-beta.secret
chmod 600 ~/.wingbot/alpha-beta.secret
```

### 2. Install on Both Bot Hosts
Copy the secret file to both bot execution environments:
```bash
# On each bot host:
mkdir -p ~/.wingbot
chmod 700 ~/.wingbot
# (Copy secret file)
chmod 600 ~/.wingbot/alpha-beta.secret
```

> **IMPORTANT**: Never commit `*.secret` files to git and never paste raw secrets in public chats, tickets, or issue trackers.

---

## Step 4: Configure Cloudflare Worker Secrets & Variables

Inspect the required secrets by running:
```bash
node cli/wingbot-registry.mjs print-secret-commands
```

Follow the prompts to upload each secret to Cloudflare:

### 1. Upload Webhook Keys
```bash
npx wrangler secret put WEBHOOK_KEY_TEAM_ALPHA_RESEARCHER
# Paste Bot A's webhook sender key when prompted

npx wrangler secret put WEBHOOK_KEY_TEAM_BETA_SYNTHESIZER
# Paste Bot B's webhook sender key when prompted
```

### 2. Upload the Pair HMAC Secret
```bash
npx wrangler secret put HMAC_PAIR_ALPHA_BETA
# Paste the 64-character hex string generated in Step 3
```

### 3. Configure `REGISTRY_JSON` in `wrangler.toml`
`REGISTRY_JSON` is a non-secret configuration variable holding bot identifiers, webhook URLs, and secret *binding names*—it contains no secret values. **Do not store it as a wrangler secret.**

Place the compact JSON representation under `[vars]` in `wrangler.toml`:
```toml
[vars]
REGISTRY_JSON = '''
{
  "version": 1,
  "bots": [ ... ],
  "pairs": [ ... ]
}
'''
```

---

## Step 5: Deploy the Relay

Deploy the updated Worker configuration to Cloudflare:
```bash
npx wrangler deploy
```

---

## Step 6: Test the Integration

Test the connection using either `cli/wingbot-send.sh` (Bash) or `cli/wingbot-send.mjs` (Node.js).

### 1. Test with Dry Run (Verify Signing & Payload)
Run a dry run from Bot A's environment:
```bash
WINGBOT_URL="https://wingbot.<your-subdomain>.workers.dev" \
WINGBOT_BOT="team-alpha:researcher" \
WINGBOT_SECRET_FILE=~/.wingbot/alpha-beta.secret \
./cli/wingbot-send.sh \
  --to "team-beta:synthesizer" \
  --kind task \
  --task "Ping: verify connection" \
  --dry-run
```
Output will display the exact canonical payload and redacted signature.

### 2. Send Real Message
Execute the command without `--dry-run`:
```bash
WINGBOT_URL="https://wingbot.<your-subdomain>.workers.dev" \
WINGBOT_BOT="team-alpha:researcher" \
WINGBOT_SECRET_FILE=~/.wingbot/alpha-beta.secret \
./cli/wingbot-send.sh \
  --to "team-beta:synthesizer" \
  --kind task \
  --task "Ping: verify connection"
```
Expected output:
```
HTTP Status: 202
{"id":"<uuid>","status":"delivered"}
```

### 3. Verify Target Bot & Reply
1. Check Bot B's routine history to confirm receipt of the webhook.
2. Bot B's routine requests explicit owner approval in chat (as required by `ROUTINE_PROMPT.md`).
3. Once approved by the owner, Bot B replies using `kind=result`:
   ```bash
   WINGBOT_URL="https://wingbot.<your-subdomain>.workers.dev" \
   WINGBOT_BOT="team-beta:synthesizer" \
   WINGBOT_SECRET_FILE=~/.wingbot/alpha-beta.secret \
   ./cli/wingbot-send.sh \
     --to "team-alpha:researcher" \
     --kind result \
     --reply-to "<original-message-uuid>" \
     --task "Pong: connection verified successfully"
   ```

---

## Troubleshooting

| Error | Common Cause | Resolution |
|---|---|---|
| `401 {"error":"unauthorized"}` | Secret mismatch, clock skew > 300s, or unknown pair | Ensure `alpha-beta.secret` matches `HMAC_PAIR_ALPHA_BETA` in Cloudflare; check system clock (`date +%s`). |
| `404 {"error":"not_found"}` | Incorrect URL path or HTTP method | Verify endpoint is `POST /v1/messages`. |
| `400 {"error":"bad_request"}` | Missing required fields, task > 16 KiB, body > 64 KiB | Check envelope JSON schema. |
| `409 {"error":"duplicate"}` | Replay attack detected (same UUID resent) | Generate a fresh UUID for each message. |
| `429 {"error":"rate_limited"}` | Bot exceeded per-minute message quota | Wait 60 seconds or increase `rate_limit_per_min` in `registry.json`. |
| `Status: queued` | Kill-switch paused or target webhook timed out | Check kill switch status; verify target webhook URL is online. |
