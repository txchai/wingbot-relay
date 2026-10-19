#!/usr/bin/env bash
#
# cli/wingbot-send.sh - Wingbot envelope signer and dispatcher (Bash + OpenSSL + cURL)
#
# Usage (message):
#   WINGBOT_URL=https://<relay> WINGBOT_BOT=personal:wingbot WINGBOT_SECRET_FILE=~/.wingbot/pair.secret \
#     ./wingbot-send.sh --to work:wingbot --kind task --task "text" [--context-json '{}'] [--reply-to <id>] [--dry-run]
#
# Usage (admin):
#   WINGBOT_URL=https://<relay> WINGBOT_SECRET_FILE=~/.wingbot/admin.secret \
#     ./wingbot-send.sh --admin pause [--bot <target-bot-id>] [--dry-run]
#   WINGBOT_URL=https://<relay> WINGBOT_SECRET_FILE=~/.wingbot/admin.secret \
#     ./wingbot-send.sh --admin resume [--bot <target-bot-id>] [--dry-run]
#
# KEY RULE: The HMAC key is the secret string's UTF-8 bytes (not hex-decoded).
#           This matches Node.js crypto.createHmac('sha256', secretString).
#

set -euo pipefail
# Never echo secrets or commands when tracing
set +x

print_usage() {
  cat <<'EOF'
Usage:
  # Message delivery:
  WINGBOT_URL=https://<relay> WINGBOT_BOT=<from-bot> WINGBOT_SECRET_FILE=<path> \
    wingbot-send.sh --to <to-bot> [--kind task|result] --task "<text>" \
                    [--context-json '{}'] [--reply-to <id>] [--dry-run]

  # Admin kill-switch (global or per-bot):
  WINGBOT_URL=https://<relay> WINGBOT_SECRET_FILE=<path> \
    wingbot-send.sh --admin pause|resume [--bot <bot-id>] [--dry-run]

Options:
  --to <id>             Target bot ID (<account>:<bot>, e.g. work:wingbot)
  --kind <kind>         Envelope kind: "task" (default) or "result"
  --task <string>       Task text content (string <= 16 KiB)
  --context-json <json> Optional JSON context object (default: {})
  --reply-to <id>       ID of message being replied to (required if kind is result)
  --admin <action>      Admin action: "pause" or "resume"
  --bot <id>            Target bot ID for admin pause/resume (optional; omits for global)
  --dry-run             Print headers (signature redacted) and body without sending
  -h, --help            Show this help message

Environment Variables:
  WINGBOT_URL           Relay base URL (https only; no userinfo, query, or fragment)
  WINGBOT_BOT           Sender bot ID (e.g. personal:wingbot)
  WINGBOT_SECRET_FILE   Path to shared secret file (e.g. ~/.wingbot/pair.secret)
  WINGBOT_SECRET        Raw shared secret string (alternative to secret file)

Exit Codes:
  0                     Success (200 OK or 202 Accepted)
  2                     Client error (4xx) or redirect (3xx)
  3                     Server error (5xx), network failure, or timeout (20s)
  64                    Usage or configuration error
EOF
}

# ---------------------------------------------------------
# Argument Parsing
# ---------------------------------------------------------
TO=""
KIND="task"
TASK=""
CONTEXT_JSON="{}"
REPLY_TO=""
DRY_RUN=false
ADMIN_ACTION=""
ADMIN_BOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)
      TO="${2:-}"
      shift 2
      ;;
    --kind)
      KIND="${2:-}"
      shift 2
      ;;
    --task)
      TASK="${2:-}"
      shift 2
      ;;
    --context-json)
      CONTEXT_JSON="${2:-}"
      shift 2
      ;;
    --reply-to)
      REPLY_TO="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --admin)
      ADMIN_ACTION="${2:-}"
      shift 2
      ;;
    --bot)
      ADMIN_BOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      print_usage >&2
      exit 64
      ;;
  esac
done

# ---------------------------------------------------------
# Read & Validate Secret
# ---------------------------------------------------------
SECRET=""
if [[ -n "${WINGBOT_SECRET_FILE:-}" ]]; then
  # Expand leading tilde if present
  EXPANDED_FILE="${WINGBOT_SECRET_FILE/#\~/$HOME}"
  if [[ ! -f "$EXPANDED_FILE" ]]; then
    echo "Error: Secret file not found: $WINGBOT_SECRET_FILE" >&2
    exit 64
  fi
  SECRET=$(tr -d '\r\n' < "$EXPANDED_FILE")
elif [[ -n "${WINGBOT_SECRET:-}" ]]; then
  SECRET="$WINGBOT_SECRET"
else
  echo "Error: Either WINGBOT_SECRET_FILE or WINGBOT_SECRET must be set." >&2
  exit 64
fi

if [[ -z "$SECRET" ]]; then
  echo "Error: Secret is empty." >&2
  exit 64
fi

# ---------------------------------------------------------
# Validate Relay URL
# ---------------------------------------------------------
if [[ -z "${WINGBOT_URL:-}" ]]; then
  echo "Error: WINGBOT_URL environment variable is required." >&2
  exit 64
fi

if [[ "$WINGBOT_URL" != https://* ]]; then
  echo "Error: WINGBOT_URL must use https:// protocol (got '$WINGBOT_URL')." >&2
  exit 64
fi

if [[ "$WINGBOT_URL" == *\?* ]]; then
  echo "Error: WINGBOT_URL must not contain a query string." >&2
  exit 64
fi

if [[ "$WINGBOT_URL" == *\#* ]]; then
  echo "Error: WINGBOT_URL must not contain a fragment." >&2
  exit 64
fi

if [[ "$WINGBOT_URL" == *@* ]]; then
  echo "Error: WINGBOT_URL must not contain userinfo/credentials." >&2
  exit 64
fi

BASE_URL="${WINGBOT_URL%/}"

# ---------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------

# Generate UUID v4
generate_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    tr '[:upper:]' '[:lower:]' < /proc/sys/kernel/random/uuid
  else
    # Fallback to OpenSSL random hex formatted as UUID v4
    local hex
    hex=$(openssl rand -hex 16)
    printf "%s-%s-4%s-a%s-%s\n" \
      "${hex:0:8}" "${hex:8:4}" "${hex:13:3}" "${hex:17:3}" "${hex:20:12}"
  fi
}

# Escape string for JSON without requiring jq
escape_json_string() {
  printf '%s' "$1" | awk '
    BEGIN { first=1 }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      gsub(/\r/, "\\r")
      gsub(/\t/, "\\t")
      if (!first) {
        printf "\\n"
      }
      printf "%s", $0
      first=0
    }
  '
}

# ---------------------------------------------------------
# Prepare Request Body & Path
# ---------------------------------------------------------
TS=$(date +%s)
FROM_BOT=""
REQ_PATH=""
BODY=""

if [[ -n "$ADMIN_ACTION" ]]; then
  # Admin Mode
  if [[ "$ADMIN_ACTION" != "pause" && "$ADMIN_ACTION" != "resume" ]]; then
    echo "Error: --admin must be either 'pause' or 'resume' (got '$ADMIN_ACTION')." >&2
    exit 64
  fi

  FROM_BOT="admin"
  REQ_PATH="/v1/admin/${ADMIN_ACTION}"

  if [[ -n "$ADMIN_BOT" ]]; then
    ESCAPED_BOT=$(escape_json_string "$ADMIN_BOT")
    BODY=$(printf '{"bot":"%s"}' "$ESCAPED_BOT")
  else
    BODY='{"bot":null}'
  fi

else
  # Message Mode
  REQ_PATH="/v1/messages"
  FROM_BOT="${WINGBOT_BOT:-}"

  if [[ -z "$FROM_BOT" ]]; then
    echo "Error: WINGBOT_BOT must be set in message mode." >&2
    exit 64
  fi

  if [[ -z "$TO" ]]; then
    echo "Error: --to <bot-id> is required in message mode." >&2
    exit 64
  fi

  if [[ "$KIND" != "task" && "$KIND" != "result" ]]; then
    echo "Error: --kind must be 'task' or 'result' (got '$KIND')." >&2
    exit 64
  fi

  if [[ "$KIND" == "result" && -z "$REPLY_TO" ]]; then
    echo "Error: --reply-to <id> is required when --kind is 'result'." >&2
    exit 64
  fi

  # Validate task byte length <= 16 KiB (16384 bytes)
  TASK_BYTES=$(printf '%s' "$TASK" | wc -c | awk '{print $1}')
  if [[ "$TASK_BYTES" -gt 16384 ]]; then
    echo "Error: Task exceeds 16 KiB limit ($TASK_BYTES bytes)." >&2
    exit 64
  fi

  # Validate context JSON format (basic check)
  TRIMMED_CONTEXT=$(printf '%s' "$CONTEXT_JSON" | tr -d '[:space:]')
  if [[ -z "$TRIMMED_CONTEXT" ]]; then
    CONTEXT_JSON="{}"
  elif [[ "${TRIMMED_CONTEXT:0:1}" != "{" || "${TRIMMED_CONTEXT: -1}" != "}" ]]; then
    echo "Error: --context-json must be a valid JSON object string (enclosed in {})." >&2
    exit 64
  fi

  UUID=$(generate_uuid)
  TASK_ESCAPED=$(escape_json_string "$TASK")
  FROM_ESCAPED=$(escape_json_string "$FROM_BOT")
  TO_ESCAPED=$(escape_json_string "$TO")

  if [[ -n "$REPLY_TO" ]]; then
    REPLY_TO_ESCAPED=$(escape_json_string "$REPLY_TO")
    REPLY_TO_JSON=$(printf '"%s"' "$REPLY_TO_ESCAPED")
  else
    REPLY_TO_JSON="null"
  fi

  # Envelope v1 (CONTRACT.md):
  # {"v":1,"id":"...","kind":"task"|"result","from":"...","to":"...","task":"...","context":{},"reply_to":null,"ts":<unix>}
  BODY=$(printf '{"v":1,"id":"%s","kind":"%s","from":"%s","to":"%s","task":"%s","context":%s,"reply_to":%s,"ts":%d}' \
    "$UUID" "$KIND" "$FROM_ESCAPED" "$TO_ESCAPED" "$TASK_ESCAPED" "$CONTEXT_JSON" "$REPLY_TO_JSON" "$TS")

fi

# Check body size <= 64 KiB
BODY_BYTES=$(printf '%s' "$BODY" | wc -c | awk '{print $1}')
if [[ "$BODY_BYTES" -gt 65536 ]]; then
  echo "Error: Request body exceeds 64 KiB limit ($BODY_BYTES bytes)." >&2
  exit 64
fi

# ---------------------------------------------------------
# Compute Hash & Signature
# ---------------------------------------------------------
# 1. SHA256 of exact body raw bytes
BODY_SHA256=$(printf '%s' "$BODY" | openssl dgst -sha256 | awk '{print $NF}')

# 2. Canonical string per CONTRACT.md:
#    wingbot-v1\n<timestamp>\nPOST\n<path>\n<body_sha256>
CANONICAL=$(printf "wingbot-v1\n%s\nPOST\n%s\n%s" "$TS" "$REQ_PATH" "$BODY_SHA256")

# 3. HMAC-SHA256 using the UTF-8 bytes of $SECRET as the raw key string (-hmac).
SIG=$(printf '%s' "$CANONICAL" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')

# ---------------------------------------------------------
# Dispatch or Dry Run
# ---------------------------------------------------------
FULL_URL="${BASE_URL}${REQ_PATH}"

if [[ "$DRY_RUN" == true ]]; then
  REDACTED_SIG="${SIG:0:8}...[redacted]"
  echo "--- DRY RUN ---"
  echo "Endpoint: POST $FULL_URL"
  echo "Headers:"
  echo "  Content-Type: application/json"
  echo "  X-Wingbot-Bot: $FROM_BOT"
  echo "  X-Wingbot-Timestamp: $TS"
  echo "  X-Wingbot-Signature: v1=$REDACTED_SIG"
  echo "Body:"
  echo "$BODY"
  exit 0
fi

# Send HTTP request via cURL (timeout 20s, HTTPS only, no config)
RESPONSE=$(curl -q -sS --max-time 20 --proto =https \
  -w "\n%{http_code}" \
  -X POST "$FULL_URL" \
  -H "Content-Type: application/json" \
  -H "X-Wingbot-Bot: $FROM_BOT" \
  -H "X-Wingbot-Timestamp: $TS" \
  -H "X-Wingbot-Signature: v1=$SIG" \
  --data-binary "$BODY") || {
    CURL_EXIT=$?
    echo "Error: cURL failed with exit code $CURL_EXIT" >&2
    exit 3
  }

# Separate body and HTTP status code
HTTP_STATUS=$(printf '%s' "$RESPONSE" | tail -n 1)
RESPONSE_BODY=$(printf '%s' "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_STATUS"
if [[ -n "$RESPONSE_BODY" ]]; then
  echo "$RESPONSE_BODY"
fi

if [[ "$HTTP_STATUS" =~ ^[0-9]+$ ]]; then
  if [[ "$HTTP_STATUS" -eq 200 || "$HTTP_STATUS" -eq 202 ]]; then
    exit 0
  elif [[ "$HTTP_STATUS" -ge 300 && "$HTTP_STATUS" -lt 500 ]]; then
    exit 2
  elif [[ "$HTTP_STATUS" -ge 500 ]]; then
    exit 3
  else
    exit 3
  fi
else
  exit 3
fi
