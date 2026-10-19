import type {
  AuditEvent,
  BotId,
  DeliveryResult,
  Envelope,
  Env,
  MessageRow,
  MessageStatus,
  Registry,
  RegistryBot,
  VerifyErr,
  VerifyOk,
} from "./types";

export interface Store {
  // Both names atomically insert the full row and claim messages.id.
  // Return false only for a duplicate id; propagate other storage failures.
  claimId(message: MessageRow): Promise<boolean>;
  insertMessage(message: MessageRow): Promise<boolean>;
  // Persist the attempt and update the message's attempt count.
  recordAttempt(
    messageId: string,
    attempt: number,
    result: DeliveryResult,
  ): Promise<void>;
  markStatus(
    messageId: string,
    status: MessageStatus,
    now: number,
    nextAttemptAt: number | null,
    lastStatusCode: number | null,
  ): Promise<void>;
  dueForRetry(now: number, limit: number): Promise<MessageRow[]>;
  // Fail a revoked route only while the selected row is still due and unclaimed.
  // Atomically audit route_revoked and mark failed without consuming an attempt.
  failRetry(message: MessageRow, now: number): Promise<void>;
  // Atomically lease a due retry for 300 seconds. Null means another caller won
  // or the row is no longer eligible. Completion persists attempt/status/audit
  // atomically and does nothing if this lease has been superseded.
  claimRetry?(
    messageId: string,
    attempts: number,
    now: number,
  ): Promise<{ complete(result: DeliveryResult): Promise<void> } | null>;
  // With a botId, checks both global and target-bot pause settings.
  isPaused(botId?: BotId): Promise<boolean>;
  setPaused(botId: BotId | null, paused: boolean): Promise<void>;
  // Increment the fixed 60-second window; true means the limit is exceeded.
  hitRateLimit(bot: BotId, limit: number, now: number): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
  // Purge terminal messages (including retry bodies) after seven days.
  purgeOld(now: number): Promise<void>;
}

// Type-only signatures; implementations live in their lane-owned modules.
export declare function verifyRequest(
  req: Request,
  env: Env,
  now: number,
): Promise<VerifyOk | VerifyErr>;

export declare function deliver(
  env: Env,
  envelope: Envelope,
  bot: RegistryBot,
  // Retries supply the original receipt time and current attempt number.
  relay?: { received_at: number; attempt: number },
): Promise<DeliveryResult>;

export declare function loadRegistry(env: Env): Registry;

export declare function makeStore(db: D1Database): Store;
