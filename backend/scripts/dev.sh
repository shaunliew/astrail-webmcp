#!/usr/bin/env bash
#
# Run the backend locally for development.
#
# Exists because `uv run uvicorn main:app` on its own does NOT work: main.py deliberately has no
# `load_dotenv()`, so the process starts with none of the required secrets and dies in
# config_validation. The env has to be exported into the process, which is what this does.
#
# Usage:  ./scripts/dev.sh            # edits disabled (same as production default)
#         WEBMCP_EDITS=1 ./scripts/dev.sh   # enables the WebMCP itinerary edit endpoints
#
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "backend/.env is missing — copy .env.example and fill it in." >&2; exit 1; }

# Export everything in .env without echoing any of it.
set -a
# shellcheck disable=SC1091
source .env
set +a

# ---------------------------------------------------------------------------------------------
# HARD SAFETY: never run the account-deletion sweep from a dev process.
#
# This backend points at the SHARED Supabase project. `.env.example` spells the hazard out: a
# local run with RUN_DELETION_SWEEP=true would sweep real user accounts for deletion every 120
# seconds. Unsetting it here means an inherited or stray value cannot reach the app.
# ---------------------------------------------------------------------------------------------
unset RUN_DELETION_SWEEP

# The frontend dev server takes whatever port is free (3000 is often occupied), and a missing
# origin surfaces in the browser as an opaque CORS failure rather than a useful error — see the
# note at main.py's CORS setup. Allow the usual dev ports regardless of what .env says.
export ALLOWED_ORIGINS="http://localhost:3000,http://localhost:3001,http://localhost:3002,${ALLOWED_ORIGINS:-}"

# Itinerary editing is flag-gated off by default, exactly as in production. Opt in explicitly.
if [ "${WEBMCP_EDITS:-0}" = "1" ]; then
  export WEBMCP_EDITS_ENABLED=true
  echo "WEBMCP_EDITS_ENABLED=true  — PATCH/DELETE/POST trip-place routes are LIVE"
  echo "   These write to the Supabase project in backend/.env. Real rows."
else
  export WEBMCP_EDITS_ENABLED=false
  echo "WEBMCP_EDITS_ENABLED=false — edit routes return 404. Set WEBMCP_EDITS=1 to enable."
fi

echo "deletion sweep: disabled"
echo "listening on http://localhost:${PORT:-8000}  (override with PORT=8001)"
# Bind 0.0.0.0, not 127.0.0.1. Embedded browsers (ChatGPT / Codex in-app) do not treat every
# loopback form alike — 127.0.0.1 can come back ERR_BLOCKED_BY_CLIENT while `localhost` resolves
# fine, and binding only to the literal 127.0.0.1 rules out the other spellings entirely.
exec uv run uvicorn main:app --reload --host 0.0.0.0 --port "${PORT:-8000}"
