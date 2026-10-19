# Contributing

Thanks for helping!

1. Fork, then `npm install`.
2. Make your change with tests. `npm run test:all` and `npm run typecheck` must pass. Tests use `wrangler.test.toml` and need no Cloudflare account.
3. Keep the wire protocol (`CONTRACT.md`, `docs/PROTOCOL.md`) backward compatible, or open an issue first.
4. Never include real webhook URLs, keys, account ids, or secrets in code, tests, docs, or issues.
5. Open a pull request with a clear description of what changed and why.

Security issues: see SECURITY.md.
