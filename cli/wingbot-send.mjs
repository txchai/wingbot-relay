#!/usr/bin/env node
/**
 * cli/wingbot-send.mjs - Wingbot envelope signer and dispatcher (Node.js ESM)
 *
 * Requirements: Node >= 18 (built-in fetch, node:crypto, node:fs). Zero external dependencies.
 *
 * Exported API:
 *   export function signRequest({ secret, bot, body, ts, path })
 *
 * Usage (message):
 *   WINGBOT_URL=https://<relay> WINGBOT_BOT=personal:wingbot WINGBOT_SECRET_FILE=~/.wingbot/pair.secret \
 *     node ./cli/wingbot-send.mjs --to work:wingbot --kind task --task "text" [--context-json '{}'] [--reply-to <id>] [--dry-run]
 *
 * Usage (admin):
 *   WINGBOT_URL=https://<relay> WINGBOT_SECRET_FILE=~/.wingbot/admin.secret \
 *     node ./cli/wingbot-send.mjs --admin pause [--bot <target-bot-id>] [--dry-run]
 *
 * KEY RULE: The HMAC key is the secret string's UTF-8 bytes (not hex-decoded).
 */

import { createHmac, createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Defaults from ~/.wingbot/env (KEY=VALUE lines). Variables already set in the environment win.
// Only applied when run as a CLI, so importing signRequest() has no side effects on process.env.
function loadEnvDefaults() {
  const envPath = process.env.WINGBOT_ENV_FILE || resolve(homedir(), '.wingbot', 'env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(WINGBOT_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

/**
 * Sign an HTTP request according to the Wingbot frozen contract.
 *
 * @param {object} params
 * @param {string} params.secret - Shared secret string (treated as raw UTF-8 bytes for HMAC)
 * @param {string} params.bot - Sender bot ID (e.g. "personal:wingbot" or "admin")
 * @param {string|Buffer|Uint8Array|object} params.body - Request payload
 * @param {number|string} [params.ts] - Unix epoch timestamp in seconds
 * @param {string} [params.path] - HTTP request path (e.g. "/v1/messages", "/v1/admin/pause")
 * @returns {Record<string, string>} HTTP headers map including signature
 */
export function signRequest({ secret, bot, body, ts, path = '/v1/messages' }) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('signRequest requires a non-empty string secret');
  }
  if (!bot || typeof bot !== 'string') {
    throw new Error('signRequest requires a non-empty string bot identifier');
  }
  if (!path || typeof path !== 'string') {
    throw new Error('signRequest requires a request path (e.g. /v1/messages)');
  }

  const timestamp = ts !== undefined ? String(ts) : String(Math.floor(Date.now() / 1000));

  let rawBytes;
  if (typeof body === 'string') {
    rawBytes = Buffer.from(body, 'utf8');
  } else if (Buffer.isBuffer(body)) {
    rawBytes = body;
  } else if (body instanceof Uint8Array) {
    rawBytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  } else if (body !== undefined && body !== null) {
    rawBytes = Buffer.from(JSON.stringify(body), 'utf8');
  } else {
    rawBytes = Buffer.from('', 'utf8');
  }

  // 1. Lowercase hex sha256 of raw body bytes
  const bodySha256 = createHash('sha256').update(rawBytes).digest('hex');

  // 2. Canonical string: wingbot-v1\n<timestamp>\nPOST\n<path>\n<body_sha256>
  const canonical = ['wingbot-v1', timestamp, 'POST', path, bodySha256].join('\n');

  // 3. HMAC-SHA256 over canonical string using secret's UTF-8 bytes as key
  const signature = createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    'Content-Type': 'application/json',
    'X-Wingbot-Bot': bot,
    'X-Wingbot-Timestamp': timestamp,
    'X-Wingbot-Signature': `v1=${signature}`,
  };
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------
function printUsage() {
  console.log(`
Usage:
  # Message delivery:
  WINGBOT_URL=https://<relay> WINGBOT_BOT=<from-bot> WINGBOT_SECRET_FILE=<path> \\
    node wingbot-send.mjs --to <to-bot> [--kind task|result] --task "<text>" \\
                          [--context-json '{}'] [--reply-to <id>] [--dry-run]

  # Admin kill-switch (global or per-bot):
  WINGBOT_URL=https://<relay> WINGBOT_SECRET_FILE=<path> \\
    node wingbot-send.mjs --admin pause|resume [--bot <bot-id>] [--dry-run]

Options:
  --to <id>             Target bot ID (<account>:<bot>, e.g. work:wingbot)
  --kind <kind>         Envelope kind: "task" (default) or "result"
  --task <string>       Task text content (string <= 16 KiB)
  --context-json <json> Optional JSON context object (default: {})
  --reply-to <id>       ID of message being replied to (required if kind is result)
  --admin <action>      Admin action: "pause" or "resume"
  --bot <id>            Target bot ID for admin pause/resume (optional)
  --dry-run             Print headers (signature redacted) and body without sending
  -h, --help            Show this help message

Environment Variables:
  WINGBOT_URL           Relay base URL (https only; no userinfo, query, or fragment)
  WINGBOT_BOT           Sender bot ID (e.g. personal:wingbot)
  WINGBOT_SECRET_FILE   Path to shared secret file (e.g. ~/.wingbot/pair.secret)
  WINGBOT_SECRET        Raw shared secret string (alternative to secret file)

Exit Codes:
  0                     Success (200 OK or 202 Accepted)
  2                     Client error (4xx) or redirect (3xx)
  3                     Server error (5xx), network failure, or timeout (20s)
  64                    Usage or configuration error
`);
}

function parseCliArgs(args) {
  const options = {
    to: '',
    kind: 'task',
    task: '',
    contextJson: '{}',
    replyTo: null,
    dryRun: false,
    adminAction: null,
    adminBot: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--to') {
      options.to = args[++i];
    } else if (arg === '--kind') {
      options.kind = args[++i];
    } else if (arg === '--task') {
      options.task = args[++i];
    } else if (arg === '--context-json') {
      options.contextJson = args[++i];
    } else if (arg === '--reply-to') {
      options.replyTo = args[++i];
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--admin') {
      options.adminAction = args[++i];
    } else if (arg === '--bot') {
      options.adminBot = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: Unknown argument: ${arg}`);
      printUsage();
      process.exit(64);
    }
  }

  return options;
}

function resolveSecret() {
  if (process.env.WINGBOT_SECRET_FILE) {
    let filePath = process.env.WINGBOT_SECRET_FILE;
    if (filePath.startsWith('~/')) {
      filePath = filePath.replace('~', homedir());
    }
    const resolved = resolve(filePath);
    if (!existsSync(resolved)) {
      console.error(`Error: Secret file not found: ${process.env.WINGBOT_SECRET_FILE}`);
      process.exit(64);
    }
    const content = readFileSync(resolved, 'utf8').trim();
    if (!content) {
      console.error(`Error: Secret file is empty: ${process.env.WINGBOT_SECRET_FILE}`);
      process.exit(64);
    }
    return content;
  }

  if (process.env.WINGBOT_SECRET) {
    const secret = process.env.WINGBOT_SECRET.trim();
    if (!secret) {
      console.error('Error: WINGBOT_SECRET is empty.');
      process.exit(64);
    }
    return secret;
  }

  console.error('Error: Either WINGBOT_SECRET_FILE or WINGBOT_SECRET must be set.');
  process.exit(64);
}

async function runCli() {
  const options = parseCliArgs(process.argv.slice(2));
  const secret = resolveSecret();

  const rawUrl = (process.env.WINGBOT_URL || '').trim();
  if (!rawUrl) {
    console.error('Error: WINGBOT_URL environment variable is required.');
    process.exit(64);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    console.error(`Error: WINGBOT_URL is not a valid URL: "${rawUrl}"`);
    process.exit(64);
  }

  if (parsedUrl.protocol !== 'https:') {
    console.error(`Error: WINGBOT_URL must use https:// protocol (got "${parsedUrl.protocol}").`);
    process.exit(64);
  }

  if (parsedUrl.username || parsedUrl.password) {
    console.error('Error: WINGBOT_URL must not contain userinfo/credentials.');
    process.exit(64);
  }

  if (parsedUrl.search) {
    console.error('Error: WINGBOT_URL must not contain a query string.');
    process.exit(64);
  }

  if (parsedUrl.hash) {
    console.error('Error: WINGBOT_URL must not contain a fragment.');
    process.exit(64);
  }

  const baseUrl = rawUrl.replace(/\/+$/, '');

  const ts = Math.floor(Date.now() / 1000);
  let path = '';
  let fromBot = '';
  let bodyString = '';

  if (options.adminAction) {
    if (options.adminAction !== 'pause' && options.adminAction !== 'resume') {
      console.error(`Error: --admin must be 'pause' or 'resume' (got '${options.adminAction}').`);
      process.exit(64);
    }

    fromBot = 'admin';
    path = `/v1/admin/${options.adminAction}`;
    bodyString = JSON.stringify({ bot: options.adminBot || null });
  } else {
    path = '/v1/messages';
    fromBot = (process.env.WINGBOT_BOT || '').trim();

    if (!fromBot) {
      console.error('Error: WINGBOT_BOT environment variable is required in message mode.');
      process.exit(64);
    }

    if (!options.to) {
      console.error('Error: --to <bot-id> is required in message mode.');
      process.exit(64);
    }

    if (options.kind !== 'task' && options.kind !== 'result') {
      console.error(`Error: --kind must be 'task' or 'result' (got '${options.kind}').`);
      process.exit(64);
    }

    if (options.kind === 'result' && !options.replyTo) {
      console.error("Error: --reply-to <id> is required when --kind is 'result'.");
      process.exit(64);
    }

    const taskBytes = Buffer.byteLength(options.task || '', 'utf8');
    if (taskBytes > 16384) {
      console.error(`Error: Task exceeds 16 KiB limit (${taskBytes} bytes).`);
      process.exit(64);
    }

    let parsedContext = {};
    if (options.contextJson) {
      try {
        parsedContext = JSON.parse(options.contextJson);
        if (typeof parsedContext !== 'object' || parsedContext === null || Array.isArray(parsedContext)) {
          throw new Error('context must be a JSON object');
        }
      } catch (e) {
        console.error(`Error: --context-json must be a valid JSON object: ${e.message}`);
        process.exit(64);
      }
    }

    const envelope = {
      v: 1,
      id: randomUUID(),
      kind: options.kind,
      from: fromBot,
      to: options.to,
      task: options.task || '',
      context: parsedContext,
      reply_to: options.replyTo || null,
      ts: ts,
    };

    bodyString = JSON.stringify(envelope);
  }

  const bodyBytes = Buffer.byteLength(bodyString, 'utf8');
  if (bodyBytes > 65536) {
    console.error(`Error: Request body exceeds 64 KiB limit (${bodyBytes} bytes).`);
    process.exit(64);
  }

  const headers = signRequest({
    secret,
    bot: fromBot,
    body: bodyString,
    ts,
    path,
  });

  const fullUrl = `${baseUrl}${path}`;

  if (options.dryRun) {
    const rawSig = headers['X-Wingbot-Signature'] || '';
    const redactedSig = rawSig.startsWith('v1=')
      ? `v1=${rawSig.slice(3, 11)}...[redacted]`
      : `${rawSig.slice(0, 8)}...[redacted]`;

    console.log('--- DRY RUN ---');
    console.log(`Endpoint: POST ${fullUrl}`);
    console.log('Headers:');
    console.log(`  Content-Type: ${headers['Content-Type']}`);
    console.log(`  X-Wingbot-Bot: ${headers['X-Wingbot-Bot']}`);
    console.log(`  X-Wingbot-Timestamp: ${headers['X-Wingbot-Timestamp']}`);
    console.log(`  X-Wingbot-Signature: ${redactedSig}`);
    console.log('Body:');
    console.log(bodyString);
    process.exit(0);
  }

  try {
    const response = await fetch(fullUrl, {
      method: 'POST',
      headers,
      body: bodyString,
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    });

    const respText = await response.text();
    console.log(`HTTP Status: ${response.status}`);
    if (respText) {
      console.log(respText);
    }

    if (response.status === 200 || response.status === 202) {
      process.exit(0);
    } else if (response.status >= 300 && response.status < 500) {
      process.exit(2);
    } else {
      process.exit(3);
    }
  } catch (err) {
    console.error(`Error: Request failed: ${err.message}`);
    process.exit(3);
  }
}

// Execute CLI if run directly
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  loadEnvDefaults();
  runCli().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(3);
  });
}
