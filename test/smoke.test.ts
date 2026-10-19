import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("returns the contract's generic 404 for an unknown route", async () => {
  const response = await SELF.fetch("https://wingbot.test/unknown");

  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "not_found" });
});
