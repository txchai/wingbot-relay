// Independent wire-format implementation: do not import production HMAC helpers.
// Check the CLI signer independently using Workers WebCrypto and fixed vectors.
export async function signRequest({ secret, bot, body, ts, path = "/v1/messages" }: {
  secret: string;
  bot: string;
  body: string;
  ts: number;
  path?: string;
}): Promise<Record<string, string>> {
  const encoder = new TextEncoder();
  const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const canonical = `wingbot-v1\n${ts}\nPOST\n${path}\n${digest}`;
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
  return {
    "Content-Type": "application/json",
    "X-Wingbot-Bot": bot,
    "X-Wingbot-Timestamp": String(ts),
    "X-Wingbot-Signature": `v1=${signature}`,
  };
}
