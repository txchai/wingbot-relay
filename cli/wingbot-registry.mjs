#!/usr/bin/env node
/**
 * cli/wingbot-registry.mjs - Wingbot registry management CLI
 *
 * Zero-dependency helper for maintaining registry.json:
 *   - add-bot --id <id> --webhook-url <url> [--rate 30] [--key-secret <name>]
 *   - add-pair --name <name> --a <id> --b <id> [--hmac-secret <name>]
 *   - validate [--file registry.json]
 *   - print-secret-commands [--file registry.json]
 *   - gen-secret [--out <path> | --stdout]
 */

import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const BOT_ID_REGEX = /^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$/;
export const PAIR_NAME_REGEX = /^[a-z0-9-]{1,64}$/;
export const HMAC_SECRET_REGEX = /^HMAC_PAIR_[A-Z0-9_]+$/;
export const WEBHOOK_KEY_SECRET_REGEX = /^WEBHOOK_KEY_[A-Z0-9_]+$/;
export const FORBIDDEN_SECRETS = new Set(['ADMIN_HMAC', 'REGISTRY_JSON', 'DB']);

const ROOT_KEYS = new Set(['version', 'bots', 'pairs']);
const BOT_KEYS = new Set(['id', 'webhook_url', 'webhook_key_secret', 'rate_limit_per_min', 'enabled']);
const PAIR_KEYS = new Set(['name', 'bots', 'hmac_secret', 'enabled']);

function printHelp() {
  console.log(`
Wingbot Registry Manager (zero-dependency)

Commands:
  add-bot                  Add or update a bot in registry.json
    --id <id>              Bot identifier, format: <account>:<bot> (e.g. personal:wingbot)
    --webhook-url <url>    Bot routine webhook trigger URL
    --rate <num>           Rate limit messages per minute (default: 30)
    --key-secret <name>    Secret name for webhook key (default: derived from ID)
    --disabled             Mark bot as disabled (default: enabled)
    --file <path>          Path to registry JSON file (default: registry.json)

  add-pair                 Add or update a communication pair in registry.json
    --name <name>          Pair identifier name (e.g. personal-work)
    --a <bot-id>           First bot identifier
    --b <bot-id>           Second bot identifier
    --hmac-secret <name>   Secret name for pair HMAC (default: derived from name)
    --disabled             Mark pair as disabled (default: enabled)
    --file <path>          Path to registry JSON file (default: registry.json)

  validate                 Validate the registry structure, constraints, and pairs
    --file <path>          Path to registry JSON file (default: registry.json)

  print-secret-commands    Print Cloudflare Wrangler secret commands needed by registry
    --file <path>          Path to registry JSON file (default: registry.json)

  gen-secret               Generate a cryptographically secure 256-bit (64-char hex) secret
    --out <path>           Write secret to file with restricted permissions (0600)
    --stdout               Print secret to stdout (explicit confirmation required)

Examples:
  node cli/wingbot-registry.mjs gen-secret --out ~/.wingbot/personal-work.secret
  node cli/wingbot-registry.mjs add-bot --id personal:wingbot --webhook-url https://api2.cursor.sh/automations/webhook/123 --rate 30
  node cli/wingbot-registry.mjs add-bot --id work:wingbot --webhook-url https://api2.cursor.sh/automations/webhook/456 --rate 30
  node cli/wingbot-registry.mjs add-pair --name personal-work --a personal:wingbot --b work:wingbot
  node cli/wingbot-registry.mjs validate
  node cli/wingbot-registry.mjs print-secret-commands
`);
}

function deriveBotSecretName(botId) {
  const [account, bot] = botId.split(':');
  const accPart = account.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const botPart = bot.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `WEBHOOK_KEY_${accPart}_${botPart}`;
}

function derivePairSecretName(pairName) {
  const namePart = pairName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `HMAC_PAIR_${namePart}`;
}

function loadRegistry(filePath, createIfMissing = false) {
  const fullPath = resolve(filePath);
  if (!existsSync(fullPath)) {
    if (createIfMissing) {
      const initial = { version: 1, bots: [], pairs: [] };
      saveRegistry(fullPath, initial);
      return initial;
    }
    throw new Error(`Registry file not found: ${filePath}`);
  }

  const raw = readFileSync(fullPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${filePath} as JSON: ${err.message}`);
  }
}

function saveRegistry(filePath, data) {
  const fullPath = resolve(filePath);
  const dir = dirname(fullPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Command Handlers
// ---------------------------------------------------------------------------

function handleAddBot(flags) {
  const filePath = flags.file || 'registry.json';
  const id = flags.id;
  const webhookUrl = flags['webhook-url'];
  const rate = flags.rate !== undefined ? parseInt(flags.rate, 10) : 30;
  const keySecret = flags['key-secret'] || (id ? deriveBotSecretName(id) : null);
  const enabled = flags.disabled ? false : true;

  if (!id) {
    console.error('Error: --id is required (e.g. personal:wingbot).');
    process.exit(1);
  }

  if (id === 'admin') {
    console.error('Error: Bot ID cannot be reserved identifier "admin".');
    process.exit(1);
  }

  if (!BOT_ID_REGEX.test(id)) {
    console.error(`Error: Bot ID "${id}" does not match required format: <account>:<bot> (lowercase alphanumeric and hyphens).`);
    process.exit(1);
  }

  if (!webhookUrl) {
    console.error('Error: --webhook-url is required.');
    process.exit(1);
  }

  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== 'https:') {
      console.error(`Error: Webhook URL must use https:// protocol (got "${webhookUrl}").`);
      process.exit(1);
    }
    if (u.username || u.password) {
      console.error('Error: Webhook URL must not contain userinfo/credentials.');
      process.exit(1);
    }
    if (u.hash) {
      console.error('Error: Webhook URL must not contain a fragment.');
      process.exit(1);
    }
  } catch {
    console.error(`Error: Webhook URL is not a valid URL: "${webhookUrl}".`);
    process.exit(1);
  }

  if (isNaN(rate) || !Number.isSafeInteger(rate) || rate < 1 || rate > 10000) {
    console.error(`Error: --rate must be an integer between 1 and 10000 (got "${flags.rate}").`);
    process.exit(1);
  }

  if (!keySecret || !WEBHOOK_KEY_SECRET_REGEX.test(keySecret) || keySecret.length > 128 || FORBIDDEN_SECRETS.has(keySecret)) {
    console.error(`Error: Bot webhook key secret "${keySecret}" must match ^WEBHOOK_KEY_[A-Z0-9_]+$, <= 128 chars, and cannot be ADMIN_HMAC/REGISTRY_JSON/DB.`);
    process.exit(1);
  }

  const registry = loadRegistry(filePath, true);
  if (!Array.isArray(registry.bots)) {
    registry.bots = [];
  }

  const existingIndex = registry.bots.findIndex((b) => b.id === id);
  const botRecord = {
    id,
    webhook_url: webhookUrl,
    webhook_key_secret: keySecret,
    rate_limit_per_min: rate,
    enabled,
  };

  if (existingIndex >= 0) {
    registry.bots[existingIndex] = botRecord;
    console.log(`Updated bot "${id}" in ${filePath}`);
  } else {
    registry.bots.push(botRecord);
    console.log(`Added bot "${id}" to ${filePath}`);
  }

  saveRegistry(filePath, registry);
}

function handleAddPair(flags) {
  const filePath = flags.file || 'registry.json';
  const name = flags.name;
  const botA = flags.a;
  const botB = flags.b;
  const hmacSecret = flags['hmac-secret'] || (name ? derivePairSecretName(name) : null);
  const enabled = flags.disabled ? false : true;

  if (!name) {
    console.error('Error: --name is required for pair (e.g. personal-work).');
    process.exit(1);
  }

  if (!PAIR_NAME_REGEX.test(name)) {
    console.error(`Error: Pair name "${name}" must match format ^[a-z0-9-]{1,64}$.`);
    process.exit(1);
  }

  if (!botA || !botB) {
    console.error('Error: Both --a <bot-id> and --b <bot-id> are required.');
    process.exit(1);
  }

  if (botA === botB) {
    console.error('Error: Bot A and Bot B must be different bots.');
    process.exit(1);
  }

  if (!BOT_ID_REGEX.test(botA) || !BOT_ID_REGEX.test(botB)) {
    console.error('Error: Bot IDs must match format <account>:<bot>.');
    process.exit(1);
  }

  if (!hmacSecret || !HMAC_SECRET_REGEX.test(hmacSecret) || hmacSecret.length > 128 || FORBIDDEN_SECRETS.has(hmacSecret)) {
    console.error(`Error: Pair HMAC secret "${hmacSecret}" must match ^HMAC_PAIR_[A-Z0-9_]+$, <= 128 chars, and cannot be ADMIN_HMAC/REGISTRY_JSON/DB.`);
    process.exit(1);
  }

  const registry = loadRegistry(filePath, true);
  if (!Array.isArray(registry.pairs)) {
    registry.pairs = [];
  }

  // Verify bots exist or warn
  const registeredBotIds = new Set((registry.bots || []).map((b) => b.id));
  if (!registeredBotIds.has(botA)) {
    console.warn(`Warning: Bot "${botA}" is not currently in bots list. Make sure to add it.`);
  }
  if (!registeredBotIds.has(botB)) {
    console.warn(`Warning: Bot "${botB}" is not currently in bots list. Make sure to add it.`);
  }

  const pairRecord = {
    name,
    bots: [botA, botB],
    hmac_secret: hmacSecret,
    enabled,
  };

  const existingIndex = registry.pairs.findIndex((p) => p.name === name);
  if (existingIndex >= 0) {
    registry.pairs[existingIndex] = pairRecord;
    console.log(`Updated pair "${name}" in ${filePath}`);
  } else {
    registry.pairs.push(pairRecord);
    console.log(`Added pair "${name}" to ${filePath}`);
  }

  saveRegistry(filePath, registry);
}

export function validateRegistry(registry) {
  const errors = [];
  if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
    return ['Registry root must be a JSON object'];
  }

  for (const key of Object.keys(registry)) {
    if (!ROOT_KEYS.has(key)) {
      errors.push(`Unknown root property: "${key}"`);
    }
  }

  if (registry.version !== 1) {
    errors.push(`Invalid version: expected 1, found ${registry.version}`);
  }

  const seenBotIds = new Set();
  const seenSecrets = new Set();

  if (!Array.isArray(registry.bots)) {
    errors.push('Missing or non-array "bots" property');
  } else {
    registry.bots.forEach((bot, idx) => {
      const label = bot && typeof bot === 'object' && bot.id ? `Bot "${bot.id}"` : `Bot at index ${idx}`;
      if (typeof bot !== 'object' || bot === null || Array.isArray(bot)) {
        errors.push(`${label} must be an object`);
        return;
      }

      for (const key of Object.keys(bot)) {
        if (!BOT_KEYS.has(key)) {
          errors.push(`${label} has unknown property: "${key}"`);
        }
      }

      if (!bot.id || typeof bot.id !== 'string') {
        errors.push(`${label} missing valid "id" string`);
      } else {
        if (bot.id === 'admin') {
          errors.push(`${label} cannot use reserved id "admin"`);
        } else if (!BOT_ID_REGEX.test(bot.id)) {
          errors.push(`${label} has invalid ID format (must match ^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$)`);
        }
        if (seenBotIds.has(bot.id)) {
          errors.push(`Duplicate bot ID detected: "${bot.id}"`);
        }
        seenBotIds.add(bot.id);
      }

      if (!bot.webhook_url || typeof bot.webhook_url !== 'string') {
        errors.push(`${label} missing valid "webhook_url"`);
      } else {
        try {
          const u = new URL(bot.webhook_url);
          if (u.protocol !== 'https:') {
            errors.push(`${label} "webhook_url" must use https: protocol`);
          }
          if (u.username || u.password) {
            errors.push(`${label} "webhook_url" must not contain userinfo/credentials`);
          }
          if (u.hash) {
            errors.push(`${label} "webhook_url" must not contain a fragment`);
          }
        } catch {
          errors.push(`${label} "webhook_url" is not a valid URL`);
        }
      }

      if (!bot.webhook_key_secret || typeof bot.webhook_key_secret !== 'string') {
        errors.push(`${label} missing valid "webhook_key_secret" string`);
      } else {
        if (!WEBHOOK_KEY_SECRET_REGEX.test(bot.webhook_key_secret)) {
          errors.push(`${label} "webhook_key_secret" must match ^WEBHOOK_KEY_[A-Z0-9_]+$ (got "${bot.webhook_key_secret}")`);
        }
        if (bot.webhook_key_secret.length > 128) {
          errors.push(`${label} "webhook_key_secret" exceeds 128 characters`);
        }
        if (FORBIDDEN_SECRETS.has(bot.webhook_key_secret)) {
          errors.push(`${label} "webhook_key_secret" references forbidden secret name "${bot.webhook_key_secret}"`);
        }
        if (seenSecrets.has(bot.webhook_key_secret)) {
          errors.push(`${label} duplicate secret binding name: "${bot.webhook_key_secret}"`);
        }
        seenSecrets.add(bot.webhook_key_secret);
      }

      if (typeof bot.rate_limit_per_min !== 'number' || !Number.isSafeInteger(bot.rate_limit_per_min) || bot.rate_limit_per_min < 1 || bot.rate_limit_per_min > 10000) {
        errors.push(`${label} invalid "rate_limit_per_min" (must be integer between 1 and 10000)`);
      }

      if (typeof bot.enabled !== 'boolean') {
        errors.push(`${label} invalid "enabled" field (must be boolean)`);
      }
    });
  }

  if (!Array.isArray(registry.pairs)) {
    errors.push('Missing or non-array "pairs" property');
  } else {
    const seenPairNames = new Set();
    const seenPairs = new Set();

    registry.pairs.forEach((pair, idx) => {
      const label = pair && typeof pair === 'object' && pair.name ? `Pair "${pair.name}"` : `Pair at index ${idx}`;
      if (typeof pair !== 'object' || pair === null || Array.isArray(pair)) {
        errors.push(`${label} must be an object`);
        return;
      }

      for (const key of Object.keys(pair)) {
        if (!PAIR_KEYS.has(key)) {
          errors.push(`${label} has unknown property: "${key}"`);
        }
      }

      if (!pair.name || typeof pair.name !== 'string') {
        errors.push(`${label} missing valid "name"`);
      } else {
        if (!PAIR_NAME_REGEX.test(pair.name)) {
          errors.push(`${label} "name" must match ^[a-z0-9-]{1,64}$`);
        }
        if (seenPairNames.has(pair.name)) {
          errors.push(`Duplicate pair name detected: "${pair.name}"`);
        }
        seenPairNames.add(pair.name);
      }

      if (!Array.isArray(pair.bots) || pair.bots.length !== 2) {
        errors.push(`${label} "bots" must be an array of exactly 2 bot IDs`);
      } else {
        const [a, b] = pair.bots;
        if (typeof a !== 'string' || typeof b !== 'string') {
          errors.push(`${label} bot IDs must be strings`);
        } else {
          if (a === b) {
            errors.push(`${label} cannot pair bot with itself: "${a}"`);
          }
          if (!seenBotIds.has(a)) {
            errors.push(`${label} references unregistered bot: "${a}"`);
          }
          if (!seenBotIds.has(b)) {
            errors.push(`${label} references unregistered bot: "${b}"`);
          }
          const pairKey = [a, b].sort().join('\n');
          if (seenPairs.has(pairKey)) {
            errors.push(`${label} duplicate unordered bot pair for bots: ${a}, ${b}`);
          }
          seenPairs.add(pairKey);
        }
      }

      if (!pair.hmac_secret || typeof pair.hmac_secret !== 'string') {
        errors.push(`${label} missing valid "hmac_secret" string`);
      } else {
        if (!HMAC_SECRET_REGEX.test(pair.hmac_secret)) {
          errors.push(`${label} "hmac_secret" must match ^HMAC_PAIR_[A-Z0-9_]+$ (got "${pair.hmac_secret}")`);
        }
        if (pair.hmac_secret.length > 128) {
          errors.push(`${label} "hmac_secret" exceeds 128 characters`);
        }
        if (FORBIDDEN_SECRETS.has(pair.hmac_secret)) {
          errors.push(`${label} "hmac_secret" references forbidden secret name "${pair.hmac_secret}"`);
        }
        if (seenSecrets.has(pair.hmac_secret)) {
          errors.push(`${label} duplicate secret binding name: "${pair.hmac_secret}"`);
        }
        seenSecrets.add(pair.hmac_secret);
      }

      if (typeof pair.enabled !== 'boolean') {
        errors.push(`${label} invalid "enabled" field (must be boolean)`);
      }
    });
  }

  return errors;
}

function handleValidate(flags) {
  const filePath = flags.file || 'registry.json';
  let registry;
  try {
    registry = loadRegistry(filePath, false);
  } catch (err) {
    console.error(`Validation Failed: ${err.message}`);
    process.exit(1);
  }

  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    console.error(`Validation FAILED for ${filePath} (${errors.length} errors):`);
    errors.forEach((err) => console.error(`  - ${err}`));
    process.exit(1);
  }

  const botCount = (registry.bots || []).length;
  const pairCount = (registry.pairs || []).length;
  console.log(`Validation PASSED: ${filePath} is valid (${botCount} bots, ${pairCount} pairs).`);
}

function handlePrintSecretCommands(flags) {
  const filePath = flags.file || 'registry.json';
  let registry;
  try {
    registry = loadRegistry(filePath, false);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  console.log(`# ============================================================`);
  console.log(`# Cloudflare Worker Secret Provisioning Commands`);
  console.log(`# Source: ${filePath}`);
  console.log(`# ============================================================`);
  console.log(``);

  console.log(`# 1. Webhook sender keys for registered bots:`);
  const webhookSecrets = new Set();
  (registry.bots || []).forEach((b) => {
    if (b.webhook_key_secret && !webhookSecrets.has(b.webhook_key_secret)) {
      webhookSecrets.add(b.webhook_key_secret);
      console.log(`npx wrangler secret put ${b.webhook_key_secret}`);
    }
  });

  console.log(``);
  console.log(`# 2. HMAC shared secrets for registered bot pairs:`);
  const hmacSecrets = new Set();
  (registry.pairs || []).forEach((p) => {
    if (p.hmac_secret && !hmacSecrets.has(p.hmac_secret)) {
      hmacSecrets.add(p.hmac_secret);
      console.log(`npx wrangler secret put ${p.hmac_secret}`);
    }
  });

  console.log(``);
  console.log(`# 3. Administrative secret for kill-switch endpoints:`);
  console.log(`npx wrangler secret put ADMIN_HMAC`);

  console.log(``);
  console.log(`# 4. Set REGISTRY_JSON variable in Cloudflare Worker:`);
  const compactJson = JSON.stringify(registry);
  console.log(`# Option A: Configure in wrangler.toml under [vars]:`);
  console.log(`#   REGISTRY_JSON = '${compactJson}'`);
  console.log(``);
  console.log(`# Option B: Put as plaintext variable via wrangler:`);
  console.log(`npx wrangler secret put REGISTRY_JSON`);
}

function handleGenSecret(flags) {
  const secretHex = randomBytes(32).toString('hex');

  if (flags.out) {
    const outPath = resolve(flags.out);
    const dir = dirname(outPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write file with permissions 0600 (owner read/write only)
    writeFileSync(outPath, secretHex + '\n', { mode: 0o600 });
    try {
      chmodSync(outPath, 0o600);
    } catch {
      // best-effort chmod on systems supporting it
    }

    console.log(`Secret generated and saved securely.`);
    console.log(`Path: ${outPath}`);
    console.log(`Permissions: 0600 (-rw-------)`);
  } else if (flags.stdout) {
    console.warn(`WARNING: Printing secret to stdout.`);
    console.warn(`Ensure your shell history and screen display remain private.`);
    console.log(secretHex);
  } else {
    console.error('Error: Please specify destination for the generated secret:');
    console.error('  --out <path>    Write securely to file with 0600 permissions (recommended)');
    console.error('  --stdout        Explicitly print secret to stdout with security warning');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '-h' || command === '--help') {
    printHelp();
    process.exit(0);
  }

  const flags = parseArgs(args.slice(1));

  switch (command) {
    case 'add-bot':
      handleAddBot(flags);
      break;
    case 'add-pair':
      handleAddPair(flags);
      break;
    case 'validate':
      handleValidate(flags);
      break;
    case 'print-secret-commands':
      handlePrintSecretCommands(flags);
      break;
    case 'gen-secret':
      handleGenSecret(flags);
      break;
    default:
      console.error(`Error: Unknown command "${command}"`);
      printHelp();
      process.exit(1);
  }
}
