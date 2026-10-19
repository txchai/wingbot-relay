import { describe, expect, it } from "vitest";
import { canonicalString, hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../src/hmac";

const bodySha = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
const canonical = `wingbot-v1\n1700000000\nPOST\n/v1/messages\n${bodySha}`;

describe("HMAC wire format", () => {
  it("hashes the exact body bytes to lowercase SHA-256 hex", async () => {
    expect(await sha256Hex(new TextEncoder().encode("{}"))).toBe(bodySha);
    expect(await sha256Hex(new Uint8Array())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("includes the timestamp, method, path and hash without a trailing newline", () => {
    expect(canonicalString(1700000000, "POST", "/v1/messages", bodySha)).toBe(canonical);
    expect(canonicalString("1700000000", "POST", "/v1/admin/pause", bodySha)).toBe(
      `wingbot-v1\n1700000000\nPOST\n/v1/admin/pause\n${bodySha}`,
    );
  });

  it("uses the secret string's UTF-8 bytes as the HMAC key", async () => {
    // Independently computed with Python hashlib/hmac; do not hex-decode the key.
    expect(await hmacSha256Hex("test-pair-secret-0123456789abcdef", canonical)).toBe(
      "d184396f36bc0593c49d444fbdae9d40bf2b061bbaa4fe041396641fae9c2ab7",
    );
  });

  it.each([
    [bodySha, bodySha, true],
    [`0${bodySha.slice(1)}`, bodySha, false],
    [bodySha.slice(0, -1) + "0", bodySha, false],
    [bodySha.slice(1), bodySha, false],
    [bodySha, bodySha + "00", false],
    [bodySha.toUpperCase(), bodySha, false],
  ])("compares the complete digest (%s, %s)", (left, right, equal) => {
    expect(timingSafeEqualHex(left, right)).toBe(equal);
  });
});
