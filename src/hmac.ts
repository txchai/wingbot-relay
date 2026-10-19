const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer = bytes instanceof Uint8Array ? bytes.slice().buffer : bytes;
  return hex(await crypto.subtle.digest("SHA-256", buffer));
}

export async function hmacSha256Hex(secretString: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secretString), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function canonicalString(ts: string | number, method: string, path: string, bodySha: string): string {
  return `wingbot-v1\n${ts}\n${method}\n${path}\n${bodySha}`;
}

// Work depends only on the public lengths, never on the first differing byte.
// Callers validate the wire digest's lowercase hex format before comparison.
export function timingSafeEqualHex(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    difference |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return difference === 0;
}

export const constantTimeEqual = timingSafeEqualHex;
