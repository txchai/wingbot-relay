import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  BOT_ID_PATTERN,
  FORBIDDEN_SECRET_NAMES,
  HMAC_SECRET_PATTERN,
  PAIR_NAME_PATTERN,
  WEBHOOK_KEY_SECRET_PATTERN,
  findPair,
  loadRegistry,
  validRegistry,
} from "../src/registry";
import type { Env, Registry } from "../src/types";

function cloneRegistry(base: Registry): Registry {
  return JSON.parse(JSON.stringify(base)) as Registry;
}

function makeEnv(registry: Registry): Env {
  return { ...env, REGISTRY_JSON: JSON.stringify(registry) };
}

describe("registry validation and loading", () => {
  const baseRegistry = JSON.parse(env.REGISTRY_JSON) as Registry;

  it("accepts the valid configured deployment registry", () => {
    expect(validRegistry(baseRegistry)).toBe(true);
    const loaded = loadRegistry(env);
    expect(loaded.version).toBe(1);
    expect(loaded.bots.length).toBeGreaterThan(0);
    expect(loaded.pairs.length).toBeGreaterThan(0);
  });

  describe("regex patterns", () => {
    it("validates BOT_ID_PATTERN", () => {
      expect(BOT_ID_PATTERN.test("personal:wingbot")).toBe(true);
      expect(BOT_ID_PATTERN.test("team-1:bot-2")).toBe(true);
      expect(BOT_ID_PATTERN.test("Personal:wingbot")).toBe(false);
      expect(BOT_ID_PATTERN.test("admin")).toBe(false);
      expect(BOT_ID_PATTERN.test("")).toBe(false);
    });

    it("validates PAIR_NAME_PATTERN", () => {
      expect(PAIR_NAME_PATTERN.test("personal-work")).toBe(true);
      expect(PAIR_NAME_PATTERN.test("pair-1")).toBe(true);
      expect(PAIR_NAME_PATTERN.test("Personal-Work")).toBe(false);
      expect(PAIR_NAME_PATTERN.test("pair_xy")).toBe(false);
      expect(PAIR_NAME_PATTERN.test("")).toBe(false);
      expect(PAIR_NAME_PATTERN.test("a".repeat(64))).toBe(true);
      expect(PAIR_NAME_PATTERN.test("a".repeat(65))).toBe(false);
    });

    it("validates HMAC_SECRET_PATTERN", () => {
      expect(HMAC_SECRET_PATTERN.test("HMAC_PAIR_PERSONAL_WORK")).toBe(true);
      expect(HMAC_SECRET_PATTERN.test("HMAC_PAIR_123")).toBe(true);
      expect(HMAC_SECRET_PATTERN.test("HMAC_PAIR_")).toBe(false);
      expect(HMAC_SECRET_PATTERN.test("hmac_pair_xy")).toBe(false);
      expect(HMAC_SECRET_PATTERN.test("HMAC_PAIR_FOO-BAR")).toBe(false);
      expect(HMAC_SECRET_PATTERN.test("WEBHOOK_KEY_OTHER")).toBe(false);
    });

    it("validates WEBHOOK_KEY_SECRET_PATTERN", () => {
      expect(WEBHOOK_KEY_SECRET_PATTERN.test("WEBHOOK_KEY_PERSONAL_WINGBOT")).toBe(true);
      expect(WEBHOOK_KEY_SECRET_PATTERN.test("WEBHOOK_KEY_123")).toBe(true);
      expect(WEBHOOK_KEY_SECRET_PATTERN.test("WEBHOOK_KEY_")).toBe(false);
      expect(WEBHOOK_KEY_SECRET_PATTERN.test("webhook_key_bot")).toBe(false);
      expect(WEBHOOK_KEY_SECRET_PATTERN.test("WEBHOOK_KEY_BOT-1")).toBe(false);
      expect(HMAC_SECRET_PATTERN.test("WEBHOOK_KEY_BOT")).toBe(false);
    });
  });

  describe("pairs[].hmac_secret enforcement", () => {
    it.each([
      "HMAC_PERSONAL_WORK",
      "PAIR_HMAC_WORK",
      "WEBHOOK_KEY_OTHER",
      "HMAC_PAIR_personal_work",
      "HMAC_PAIR_FOO-BAR",
      "HMAC_PAIR_",
      "",
      "HMAC_PAIR_" + "A".repeat(120), // exceeds 128 total chars
    ])("rejects invalid pair hmac_secret format (%s)", secret => {
      const reg = cloneRegistry(baseRegistry);
      reg.pairs[0].hmac_secret = secret;
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });
  });

  describe("bots[].webhook_key_secret enforcement", () => {
    it.each([
      "WEBHOOK_PERSONAL",
      "KEY_PERSONAL",
      "HMAC_PAIR_PERSONAL",
      "WEBHOOK_KEY_personal_wingbot",
      "WEBHOOK_KEY_FOO-BAR",
      "WEBHOOK_KEY_",
      "",
      "WEBHOOK_KEY_" + "A".repeat(120), // exceeds 128 total chars
    ])("rejects invalid bot webhook_key_secret format (%s)", secret => {
      const reg = cloneRegistry(baseRegistry);
      reg.bots[0].webhook_key_secret = secret;
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });
  });

  describe("forbidden secret names (ADMIN_HMAC, REGISTRY_JSON, DB)", () => {
    it.each(["ADMIN_HMAC", "REGISTRY_JSON", "DB"])("forbids %s as bot webhook_key_secret", forbidden => {
      const reg = cloneRegistry(baseRegistry);
      reg.bots[0].webhook_key_secret = forbidden;
      expect(FORBIDDEN_SECRET_NAMES.has(forbidden)).toBe(true);
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });

    it.each(["ADMIN_HMAC", "REGISTRY_JSON", "DB"])("forbids %s as pair hmac_secret", forbidden => {
      const reg = cloneRegistry(baseRegistry);
      reg.pairs[0].hmac_secret = forbidden;
      expect(FORBIDDEN_SECRET_NAMES.has(forbidden)).toBe(true);
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });
  });

  describe("secret binding name uniqueness across bots and pairs", () => {
    it("rejects duplicate webhook_key_secret across bots", () => {
      const reg = cloneRegistry(baseRegistry);
      reg.bots[1].webhook_key_secret = reg.bots[0].webhook_key_secret;
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });

    it("rejects duplicate hmac_secret across pairs", () => {
      const reg = cloneRegistry(baseRegistry);
      reg.pairs.push({
        name: "second-pair",
        bots: [reg.bots[0].id, reg.bots[1].id],
        hmac_secret: reg.pairs[0].hmac_secret,
        enabled: true,
      });
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });

    it("rejects secret collision between a bot and a pair", () => {
      const reg = cloneRegistry(baseRegistry);
      // Give a bot an HMAC_PAIR-formatted secret name that collides with pair
      reg.bots[0].webhook_key_secret = reg.pairs[0].hmac_secret;
      expect(validRegistry(reg)).toBe(false);
      expect(() => loadRegistry(makeEnv(reg))).toThrow("invalid_registry");
    });
  });

  describe("exact keys and structure", () => {
    it("rejects unknown keys at root", () => {
      const reg = { ...cloneRegistry(baseRegistry), extra: "unknown" };
      expect(validRegistry(reg)).toBe(false);
    });

    it("rejects unknown keys in bot object", () => {
      const reg = cloneRegistry(baseRegistry);
      (reg.bots[0] as unknown as Record<string, unknown>).extra = "unknown";
      expect(validRegistry(reg)).toBe(false);
    });

    it("rejects unknown keys in pair object", () => {
      const reg = cloneRegistry(baseRegistry);
      (reg.pairs[0] as unknown as Record<string, unknown>).extra = "unknown";
      expect(validRegistry(reg)).toBe(false);
    });

    it("rejects non-object root or invalid version", () => {
      expect(validRegistry(null)).toBe(false);
      expect(validRegistry([])).toBe(false);
      expect(validRegistry("string")).toBe(false);
      expect(validRegistry({ ...cloneRegistry(baseRegistry), version: 2 })).toBe(false);
    });
  });

  describe("bot properties validation", () => {
    it("rejects bot id 'admin'", () => {
      const reg = cloneRegistry(baseRegistry);
      (reg.bots[0] as { id: string }).id = "admin";
      expect(validRegistry(reg)).toBe(false);
    });

    it.each([
      "http://api.example.com/webhook",
      "https://user:pass@api.example.com/webhook",
      "https://api.example.com/webhook#frag",
      "not-a-url",
    ])("rejects invalid webhook_url (%s)", url => {
      const reg = cloneRegistry(baseRegistry);
      reg.bots[0].webhook_url = url;
      expect(validRegistry(reg)).toBe(false);
    });

    it.each([0, -1, 10001, 1.5, NaN, Infinity, "30"])(
      "rejects invalid rate_limit_per_min (%s)",
      rate => {
        const reg = cloneRegistry(baseRegistry);
        reg.bots[0].rate_limit_per_min = rate as unknown as number;
        expect(validRegistry(reg)).toBe(false);
      },
    );
  });

  describe("pair properties validation", () => {
    it.each(["Personal-Work", "pair_1", "pair@1", "", "a".repeat(65)])(
      "rejects invalid pair name format (%s)",
      name => {
        const reg = cloneRegistry(baseRegistry);
        reg.pairs[0].name = name;
        expect(validRegistry(reg)).toBe(false);
      },
    );

    it("rejects duplicate pair name", () => {
      const reg = cloneRegistry(baseRegistry);
      reg.pairs.push({
        ...reg.pairs[0],
        hmac_secret: "HMAC_PAIR_SECOND",
      });
      expect(validRegistry(reg)).toBe(false);
    });

    it("rejects duplicate unordered pair bot set", () => {
      const reg = cloneRegistry(baseRegistry);
      reg.pairs.push({
        name: "reverse-pair",
        bots: [reg.pairs[0].bots[1], reg.pairs[0].bots[0]],
        hmac_secret: "HMAC_PAIR_REVERSE",
        enabled: true,
      });
      expect(validRegistry(reg)).toBe(false);
    });
  });

  describe("loadRegistry and findPair", () => {
    it("throws on malformed JSON string", () => {
      expect(() => loadRegistry({ ...env, REGISTRY_JSON: "{ malformed json" })).toThrow("invalid_registry");
    });

    it("findPair returns enabled pair and undefined for non-pairs or self", () => {
      const reg = loadRegistry(env);
      const [botA, botB] = reg.pairs[0].bots;
      expect(findPair(reg, botA, botB)).toBeDefined();
      expect(findPair(reg, botB, botA)).toBeDefined();
      expect(findPair(reg, botA, botA)).toBeUndefined();
      expect(findPair(reg, botA, "nonexistent:bot")).toBeUndefined();
    });
  });
});
