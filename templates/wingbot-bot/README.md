# Wingbot bot template

A paste-ready Grok Bot recipe for the **Wingbot** inbox/outbox on each side of a
[wingbot-relay](https://github.com/txchai/wingbot-relay) pair. Use this when the
built-in Grok Bot marketplace export is unavailable, or when you want a
scrubbed, generic starting point.

This template configures the **bot**, not the Cloudflare Worker. Deploy the
relay first (or in parallel) with [docs/SETUP.md](../../docs/SETUP.md).

## What this bot is

Wingbot is the only bridge on one Grok Bot account. It:

- Receives verified envelopes on a webhook routine named **Wingbot inbox**
- Shows every handoff in its own chat
- Routes tasks to the right local bot, or asks the owner
- Runs outgoing sends through the signer CLI so both sides of the conversation
  are visible
- Never takes consequential actions without explicit owner approval in chat
- Never prints secrets

You need **one Wingbot bot per account** (for example `personal:wingbot` and
`work:wingbot`).

## Install (about 10 minutes per account)

### 1. Create the bot and paste the persona

1. In the Grok Bot account, create a new bot named **Wingbot**.
2. Open [persona.md](persona.md). Copy the fenced **Description** block.
3. Replace placeholders:
   - `<THIS_BOT_ID>` — e.g. `personal:wingbot`
   - `<OTHER_BOT_ID>` — e.g. `work:wingbot`
   - `<REPO_PATH>` — e.g. `~/Projects/wingbot`
4. Paste into the bot's persona / system prompt and save.
5. On first chat, let the bot walk you through **Getting started** (relay URL,
   bot ids, repo path, pair-secret *path* only).

### 2. Add the "Wingbot inbox" webhook routine

1. On that bot, create a routine named **Wingbot inbox**.
2. Set the trigger type to **webhook**.
3. Open [routine-prompt.md](routine-prompt.md). Copy the fenced prompt block.
4. Replace `<THIS_BOT_ID>`, `<OTHER_BOT_ID>`, `<OWNER_NAME>`, and `<REPO_PATH>`.
5. Paste into the routine instructions and save.

### 3. Wire the webhook into the relay

1. Open the routine panel and copy the **webhook URL** and **webhook key**.
2. Put the URL in `wrangler.toml` for this bot (see [docs/SETUP.md](../../docs/SETUP.md)
   steps 6–7).
3. Store the key with a hidden prompt — never paste it into chat:

   ```bash
   read -rs K; printf %s "$K" | npx wrangler secret put WEBHOOK_KEY_<ACCOUNT>_WINGBOT; unset K
   ```

4. Ensure `~/.wingbot/env` and `~/.wingbot/pair.secret` exist on the signer
   machine, then deploy or redeploy the Worker if the URL changed.
5. Verify with a PING / PONG as in SETUP.md step 9.

## Files in this folder

| File | Purpose |
|---|---|
| [persona.md](persona.md) | Bot name, title, description, getting started, send rules |
| [routine-prompt.md](routine-prompt.md) | Webhook routine job text |
| [template.json](template.json) | Structured copy for tooling / future marketplace import |
| [README.md](README.md) | This install guide |

## Related docs

- [docs/SETUP.md](../../docs/SETUP.md) — full relay setup
- [docs/ROUTINE_PROMPT.md](../../docs/ROUTINE_PROMPT.md) — protocol-aligned prompt notes
- [docs/MARKETPLACE.md](../../docs/MARKETPLACE.md) — listing copy
- [CONTRACT.md](../../CONTRACT.md) — envelope and delivery contract

## Safety checklist

- [ ] No secret values in the persona or routine text
- [ ] Owner approval required before every send and every consequential action
- [ ] Dedup ledger of full envelope ids
- [ ] Never reply to `kind=result`
- [ ] Data minimization: share only what the task needs
