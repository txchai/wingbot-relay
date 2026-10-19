// Runtime validation enforces ^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$.
export type BotId = `${string}:${string}`;

export interface Envelope {
  v: 1;
  id: string;
  kind: "task" | "result";
  from: BotId;
  to: BotId;
  task: string;
  context: Record<string, unknown>;
  // Required and non-null for kind=result; validated after authentication.
  reply_to: string | null;
  ts: number;
}

export interface RegistryBot {
  id: BotId;
  webhook_url: string;
  webhook_key_secret: string;
  rate_limit_per_min: number;
  enabled: boolean;
}

export interface RegistryPair {
  name: string;
  bots: [BotId, BotId];
  hmac_secret: string;
  enabled: boolean;
}

export interface Registry {
  version: 1;
  bots: RegistryBot[];
  pairs: RegistryPair[];
}

export type MessageStatus = "queued" | "delivered" | "failed";

// All timestamps are Unix seconds; duration_ms is milliseconds.
export interface MessageRow {
  id: string;
  pair: string;
  from_bot: BotId;
  to_bot: BotId;
  kind: Envelope["kind"];
  reply_to: string | null;
  body_sha256: string;
  size: number;
  status: MessageStatus;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
  last_status_code: number | null;
  envelope_json: string;
}

export interface AuditEvent {
  at: number;
  event: string;
  message_id: string | null;
  from_bot: BotId | null;
  to_bot: BotId | null;
  kind: Envelope["kind"] | null;
  body_sha256: string | null;
  // Short reason code only; never secrets or bodies.
  detail: string | null;
}

export interface DeliveryResult {
  ok: boolean;
  http_status: number | null;
  // Short reason code only; never webhook response bodies or secrets.
  error: string | null;
  started_at: number;
  duration_ms: number;
}

export interface VerifyOk {
  ok: true;
  envelope: Envelope;
  pair: RegistryPair;
  from: RegistryBot;
  to: RegistryBot;
  body_sha256: string;
  size: number;
}

export type VerifyErr =
  | { ok: false; status: 400; error: "bad_request" }
  | { ok: false; status: 401; error: "unauthorized" };

export interface Env {
  DB: D1Database;
  REGISTRY_JSON: string;
  ADMIN_HMAC?: string;
  [secret: string]: unknown;
}
