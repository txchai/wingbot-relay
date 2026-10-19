// Native Node tests: intentionally named *.node.mjs to stay outside Vitest's
// Workers pool (Bash requires native child processes). Run: node --test test/cli.node.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signRequest } from '../cli/wingbot-send.mjs';
import { validateRegistry } from '../cli/wingbot-registry.mjs';

const sendShPath = fileURLToPath(new URL('../cli/wingbot-send.sh', import.meta.url));
const sendMjsPath = fileURLToPath(new URL('../cli/wingbot-send.mjs', import.meta.url));

function runCli(cliType, args, extraEnv = {}) {
  const isNode = cliType === 'node';
  const cmd = isNode ? process.execPath : 'bash';
  const file = isNode ? sendMjsPath : sendShPath;
  // Isolate from the developer's ~/.wingbot/env defaults so tests are hermetic.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('WINGBOT_')));
  const env = { ...inherited, WINGBOT_ENV_FILE: '/nonexistent/wingbot-test-env', ...extraEnv };
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) {
      delete env[k];
    }
  }
  return spawnSync(cmd, [file, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env,
  });
}

const vectors = JSON.parse(readFileSync(new URL('./fixtures/signing-vectors.json', import.meta.url), 'utf8'));
for (const vector of vectors) {
  test(`Node CLI signer matches the WebCrypto fixture for ${vector.path}`, () => {
    assert.deepEqual(signRequest(vector), {
      'Content-Type': 'application/json',
      'X-Wingbot-Bot': vector.bot,
      'X-Wingbot-Timestamp': String(vector.ts),
      'X-Wingbot-Signature': vector.signature,
    });
  });
}

for (const mode of ['message', 'admin']) {
  test(`Bash CLI ${mode} dry-run signs a valid body, redacts credentials and never calls curl`, () => {
    const scratch = mkdtempSync(join(tmpdir(), 'wingbot-cli-'));
    try {
      // Fail locally if the dry-run accidentally reaches the network dispatch.
      writeFileSync(join(scratch, 'curl'), '#!/bin/sh\n: > "$WINGBOT_CURL_MARKER"\nexit 95\n', { mode: 0o700 });
      const secret = 'test-bash-secret-0123456789abcdef';
      const bot = mode === 'admin' ? 'admin' : 'personal:wingbot';
      const path = mode === 'admin' ? '/v1/admin/pause' : '/v1/messages';
      const args = mode === 'admin'
        ? ['--admin', 'pause', '--bot', 'work:wingbot', '--dry-run']
        : ['--to', 'work:wingbot', '--task', 'Check relay status', '--dry-run'];
      const result = spawnSync('bash', [sendShPath, ...args], {
        encoding: 'utf8', timeout: 10_000,
        env: {
          PATH: `${scratch}:${process.env.PATH}`,
          WINGBOT_URL: 'https://wingbot.invalid', WINGBOT_BOT: bot, WINGBOT_SECRET: secret,
          WINGBOT_CURL_MARKER: join(scratch, 'curl-called'),
        },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(existsSync(join(scratch, 'curl-called')), false);
      assert.ok(result.stdout.includes(`Endpoint: POST https://wingbot.invalid${path}`));
      const body = result.stdout.split('Body:\n')[1]?.trimEnd();
      assert.ok(body, 'dry-run must print the signed body');
      const parsed = JSON.parse(body);
      if (mode === 'admin') {
        assert.deepEqual(parsed, { bot: 'work:wingbot' });
      } else {
        assert.match(parsed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        assert.deepEqual(parsed, {
          v: 1, id: parsed.id, kind: 'task', from: bot, to: 'work:wingbot',
          task: 'Check relay status', context: {}, reply_to: null, ts: parsed.ts,
        });
      }
      const timestamp = Number(result.stdout.match(/X-Wingbot-Timestamp: (\d+)/)?.[1]);
      assert.ok(Number.isSafeInteger(timestamp) && timestamp > 0);
      if (mode === 'message') assert.equal(parsed.ts, timestamp);
      const signature = signRequest({ secret, bot, body, ts: timestamp, path })['X-Wingbot-Signature'];
      assert.ok(result.stdout.includes(`X-Wingbot-Signature: ${signature.slice(0, 11)}...[redacted]`));
      assert.ok(!result.stdout.includes(signature));
      assert.ok(!result.stdout.includes(secret));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test(`Node CLI ${mode} dry-run signs a valid body, redacts credentials and never calls fetch`, () => {
    const secret = 'test-node-secret-0123456789abcdef';
    const bot = mode === 'admin' ? 'admin' : 'personal:wingbot';
    const path = mode === 'admin' ? '/v1/admin/pause' : '/v1/messages';
    const args = mode === 'admin'
      ? ['--admin', 'pause', '--bot', 'work:wingbot', '--dry-run']
      : ['--to', 'work:wingbot', '--task', 'Check relay status', '--dry-run'];
    const result = runCli('node', args, {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: bot,
      WINGBOT_SECRET: secret,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes(`Endpoint: POST https://wingbot.invalid${path}`));
    const body = result.stdout.split('Body:\n')[1]?.trimEnd();
    assert.ok(body, 'dry-run must print the signed body');
    const parsed = JSON.parse(body);
    if (mode === 'admin') {
      assert.deepEqual(parsed, { bot: 'work:wingbot' });
    } else {
      assert.match(parsed.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.deepEqual(parsed, {
        v: 1, id: parsed.id, kind: 'task', from: bot, to: 'work:wingbot',
        task: 'Check relay status', context: {}, reply_to: null, ts: parsed.ts,
      });
    }
    const timestamp = Number(result.stdout.match(/X-Wingbot-Timestamp: (\d+)/)?.[1]);
    assert.ok(Number.isSafeInteger(timestamp) && timestamp > 0);
    if (mode === 'message') assert.equal(parsed.ts, timestamp);
    const signature = signRequest({ secret, bot, body, ts: timestamp, path })['X-Wingbot-Signature'];
    assert.ok(result.stdout.includes(`X-Wingbot-Signature: ${signature.slice(0, 11)}...[redacted]`));
    assert.ok(!result.stdout.includes(signature));
    assert.ok(!result.stdout.includes(secret));
  });
}

// ---------------------------------------------------------------------------
// URL validation tests (exit code 64, no network calls)
// ---------------------------------------------------------------------------
const invalidUrls = [
  'http://wingbot.invalid',
  'ftp://wingbot.invalid',
  'https://user:pass@wingbot.invalid',
  'https://user@wingbot.invalid',
  'https://wingbot.invalid/v1/messages?foo=bar',
  'https://wingbot.invalid/v1/messages#frag',
  '',
];

for (const cliType of ['bash', 'node']) {
  for (const url of invalidUrls) {
    test(`${cliType} CLI rejects invalid WINGBOT_URL "${url}" with exit code 64`, () => {
      const result = runCli(cliType, ['--to', 'work:wingbot', '--task', 'test', '--dry-run'], {
        WINGBOT_URL: url,
        WINGBOT_BOT: 'personal:wingbot',
        WINGBOT_SECRET: 'test-secret',
      });
      assert.equal(result.status, 64, `expected 64 for url "${url}", got ${result.status}: ${result.stderr}`);
    });
  }

  test(`${cliType} CLI rejects missing WINGBOT_URL with exit code 64`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: undefined,
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64, `expected 64 for missing WINGBOT_URL, got ${result.status}`);
  });
}

// ---------------------------------------------------------------------------
// Usage error exit code 64 tests (invalid input / missing required options)
// ---------------------------------------------------------------------------
for (const cliType of ['bash', 'node']) {
  test(`${cliType} CLI exits with 64 on unknown argument`, () => {
    const result = runCli(cliType, ['--unknown-option'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 when secret is missing`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: undefined,
      WINGBOT_SECRET_FILE: undefined,
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 when secret is empty`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: '',
      WINGBOT_SECRET_FILE: undefined,
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 when WINGBOT_BOT is missing in message mode`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: undefined,
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 when --to is missing in message mode`, () => {
    const result = runCli(cliType, ['--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 on invalid --kind`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--kind', 'other', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 when result kind is missing --reply-to`, () => {
    const result = runCli(cliType, ['--to', 'work:wingbot', '--kind', 'result', '--task', 'test', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_BOT: 'personal:wingbot',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 64 on invalid --admin action`, () => {
    const result = runCli(cliType, ['--admin', 'stop', '--dry-run'], {
      WINGBOT_URL: 'https://wingbot.invalid',
      WINGBOT_SECRET: 'test-secret',
    });
    assert.equal(result.status, 64);
  });

  test(`${cliType} CLI exits with 0 on --help`, () => {
    const result = runCli(cliType, ['--help']);
    assert.equal(result.status, 0);
  });
}

// ---------------------------------------------------------------------------
// cli/wingbot-registry.mjs validation consistency test
// ---------------------------------------------------------------------------
test('cli/wingbot-registry.mjs validateRegistry matches binding-class and structure rules', () => {
  const validReg = {
    version: 1,
    bots: [
      {
        id: 'personal:wingbot',
        webhook_url: 'https://api.example.com/webhook/1',
        webhook_key_secret: 'WEBHOOK_KEY_PERSONAL_WINGBOT',
        rate_limit_per_min: 30,
        enabled: true,
      },
      {
        id: 'work:wingbot',
        webhook_url: 'https://api.example.com/webhook/2',
        webhook_key_secret: 'WEBHOOK_KEY_WORK_WINGBOT',
        rate_limit_per_min: 30,
        enabled: true,
      },
    ],
    pairs: [
      {
        name: 'personal-work',
        bots: ['personal:wingbot', 'work:wingbot'],
        hmac_secret: 'HMAC_PAIR_PERSONAL_WORK',
        enabled: true,
      },
    ],
  };
  assert.deepEqual(validateRegistry(validReg), []);

  // Unknown root key
  assert.ok(validateRegistry({ ...validReg, extra: 1 }).length > 0);
  // Invalid hmac_secret format
  const badPairSecret = JSON.parse(JSON.stringify(validReg));
  badPairSecret.pairs[0].hmac_secret = 'INVALID_SECRET';
  assert.ok(validateRegistry(badPairSecret).length > 0);
  // Forbidden secret name
  const forbiddenSecret = JSON.parse(JSON.stringify(validReg));
  forbiddenSecret.bots[0].webhook_key_secret = 'ADMIN_HMAC';
  assert.ok(validateRegistry(forbiddenSecret).length > 0);
  // Duplicate secret across bot and pair
  const duplicateSecret = JSON.parse(JSON.stringify(validReg));
  duplicateSecret.bots[0].webhook_key_secret = duplicateSecret.pairs[0].hmac_secret;
  assert.ok(validateRegistry(duplicateSecret).length > 0);
  // Non-https webhook_url
  const httpWebhook = JSON.parse(JSON.stringify(validReg));
  httpWebhook.bots[0].webhook_url = 'http://api.example.com/webhook';
  assert.ok(validateRegistry(httpWebhook).length > 0);
  // Webhook URL with userinfo
  const userinfoWebhook = JSON.parse(JSON.stringify(validReg));
  userinfoWebhook.bots[0].webhook_url = 'https://user:pass@api.example.com/webhook';
  assert.ok(validateRegistry(userinfoWebhook).length > 0);
  // Webhook URL with hash
  const hashWebhook = JSON.parse(JSON.stringify(validReg));
  hashWebhook.bots[0].webhook_url = 'https://api.example.com/webhook#section';
  assert.ok(validateRegistry(hashWebhook).length > 0);
});
