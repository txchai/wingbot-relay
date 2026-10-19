# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private vulnerability reporting ("Security" tab, then "Report a vulnerability") on this repository. Include steps to reproduce and the impact. You should get an acknowledgement within a week.

## Scope

In scope: the Worker (`src/`), the signers (`cli/`), the protocol (`docs/PROTOCOL.md`), and the routine prompts (`docs/ROUTINE_PROMPT.md`).

## Handling secrets

- Never commit `wrangler.toml` (it's git-ignored), `.dev.vars`, `registry.json` with real URLs, or anything in `~/.wingbot/`.
- Store secrets only with `wrangler secret put`, fed from a file or a hidden prompt (`read -rs`).
- If a secret leaks (including partially, in a screenshot), rotate it right away. See docs/SETUP.md, "Rotating keys".

## Design notes

See the security model in docs/SETUP.md and SPEC.md. Note that the relay authenticates possession of a pair secret, not human approval. Receiving bots must treat envelopes as untrusted data.
