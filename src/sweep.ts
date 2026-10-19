import { deliver } from "./deliver";
import { loadRegistry } from "./registry";
import { makeStore } from "./store/d1";
import type { Envelope, Env } from "./types";

// Worst case: global pause (1), selection (1), seven claims (7), seven
// terminal-completion batches (3 each), purge (3) = 33 D1 statements, <= 40.
// Revocation costs only two statements; pauses are rechecked inside each claim.
const SWEEP_LIMIT = 7;

export async function runSweep(env: Env, now: number): Promise<void> {
  const store = makeStore(env.DB);
  const registry = loadRegistry(env);
  // Per-target pauses are already filtered by dueForRetry's SQL. Retain one
  // global check and run retention even while delivery is paused.
  const rows = await store.isPaused() ? [] : await store.dueForRetry(now, SWEEP_LIMIT);
  for (const row of rows) {
    const from = registry.bots.find(candidate => candidate.id === row.from_bot && candidate.enabled);
    const to = registry.bots.find(candidate => candidate.id === row.to_bot && candidate.enabled);
    const pair = registry.pairs.find(candidate => candidate.name === row.pair && candidate.enabled);
    if (!from || !to || !pair || from.id === to.id
      || !pair.bots.includes(from.id) || !pair.bots.includes(to.id)) {
      await store.failRetry(row, now);
      continue;
    }
    const lease = await store.claimRetry(row.id, row.attempts, now);
    if (!lease) continue;
    const attempt = row.attempts + 1;
    const envelope = JSON.parse(row.envelope_json) as Envelope;
    const result = await deliver(env, envelope, to, { received_at: row.created_at, attempt });
    await lease.complete(result);
  }
  await store.purgeOld(now);
}

export { runSweep as sweep };
