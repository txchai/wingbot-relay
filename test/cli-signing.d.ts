// Test-only declaration for the standalone JavaScript CLI's public signer.
declare module "*cli/wingbot-send.mjs" {
  export function signRequest(input: {
    secret: string;
    bot: string;
    body: string | Uint8Array | object;
    ts?: number | string;
    path?: string;
  }): Record<string, string>;
}
