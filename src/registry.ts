import type * as Ports from "./ports";
import type { BotId, Registry, RegistryPair } from "./types";

export const BOT_ID_PATTERN = /^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$/;
export const PAIR_NAME_PATTERN = /^[a-z0-9-]{1,64}$/;
export const HMAC_SECRET_PATTERN = /^HMAC_PAIR_[A-Z0-9_]+$/;
export const WEBHOOK_KEY_SECRET_PATTERN = /^WEBHOOK_KEY_[A-Z0-9_]+$/;
export const FORBIDDEN_SECRET_NAMES = new Set(["ADMIN_HMAC", "REGISTRY_JSON", "DB"]);

const ROOT_KEYS = new Set(["version", "bots", "pairs"]);
const BOT_KEYS = new Set(["id", "webhook_url", "webhook_key_secret", "rate_limit_per_min", "enabled"]);
const PAIR_KEYS = new Set(["name", "bots", "hmac_secret", "enabled"]);

const cache = new Map<string, Registry>();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  const keys = Object.keys(obj);
  return keys.length === allowedKeys.size && keys.every(k => allowedKeys.has(k));
}

export function validRegistry(value: unknown): value is Registry {
  if (!object(value) || !hasExactKeys(value, ROOT_KEYS) || value.version !== 1 || !Array.isArray(value.bots) || !Array.isArray(value.pairs)) {
    return false;
  }

  const ids = new Set<string>();
  const secrets = new Set<string>();

  for (const bot of value.bots) {
    if (!object(bot) || !hasExactKeys(bot, BOT_KEYS)) return false;
    if (typeof bot.id !== "string" || !BOT_ID_PATTERN.test(bot.id) || bot.id === "admin" || ids.has(bot.id)) return false;
    if (typeof bot.webhook_url !== "string") return false;
    try {
      const u = new URL(bot.webhook_url);
      if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.hash !== "") return false;
    } catch {
      return false;
    }
    if (typeof bot.webhook_key_secret !== "string"
      || bot.webhook_key_secret.length > 128
      || !WEBHOOK_KEY_SECRET_PATTERN.test(bot.webhook_key_secret)
      || FORBIDDEN_SECRET_NAMES.has(bot.webhook_key_secret)
      || secrets.has(bot.webhook_key_secret)) return false;
    if (typeof bot.enabled !== "boolean") return false;
    if (!Number.isSafeInteger(bot.rate_limit_per_min)
      || (bot.rate_limit_per_min as number) < 1
      || (bot.rate_limit_per_min as number) > 10000) return false;

    ids.add(bot.id);
    secrets.add(bot.webhook_key_secret);
  }

  const names = new Set<string>();
  const members = new Set<string>();

  for (const pair of value.pairs) {
    if (!object(pair) || !hasExactKeys(pair, PAIR_KEYS)) return false;
    if (typeof pair.name !== "string" || !PAIR_NAME_PATTERN.test(pair.name) || names.has(pair.name)) return false;
    if (typeof pair.hmac_secret !== "string"
      || pair.hmac_secret.length > 128
      || !HMAC_SECRET_PATTERN.test(pair.hmac_secret)
      || FORBIDDEN_SECRET_NAMES.has(pair.hmac_secret)
      || secrets.has(pair.hmac_secret)) return false;
    if (typeof pair.enabled !== "boolean") return false;
    if (!Array.isArray(pair.bots) || pair.bots.length !== 2) return false;
    if (typeof pair.bots[0] !== "string" || typeof pair.bots[1] !== "string") return false;
    if (!ids.has(pair.bots[0]) || !ids.has(pair.bots[1])) return false;
    if (pair.bots[0] === pair.bots[1]) return false;

    const key = [...pair.bots].sort().join("\n");
    if (members.has(key)) return false;

    names.add(pair.name);
    members.add(key);
    secrets.add(pair.hmac_secret);
  }

  return true;
}

export const loadRegistry: typeof Ports.loadRegistry = (env) => {
  const cached = cache.get(env.REGISTRY_JSON);
  if (cached) return cached;
  let parsed: unknown;
  try {
    parsed = JSON.parse(env.REGISTRY_JSON);
  } catch {
    throw new Error("invalid_registry");
  }
  if (!validRegistry(parsed)) throw new Error("invalid_registry");
  cache.set(env.REGISTRY_JSON, parsed);
  return parsed;
};

export function findPair(registry: Registry, a: string, b: string): RegistryPair | undefined {
  if (a === b) return undefined;
  return registry.pairs.find(pair => pair.enabled && pair.bots.includes(a as BotId) && pair.bots.includes(b as BotId));
}
