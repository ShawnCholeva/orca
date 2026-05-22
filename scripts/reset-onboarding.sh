#!/usr/bin/env bash
# Reset onboarding state — clears `connected` flag on every agent so the next
# app launch shows the onboarding flow again. Goals, sessions, memory etc. are
# preserved.
#
# Honors $ORCA_DATA_DIR; otherwise uses the daemon's default
# (~/.orca on macOS/Linux, %APPDATA%/Orca on Windows — this script is *nix only).

set -euo pipefail

DATA_DIR="${ORCA_DATA_DIR:-$HOME/.orca}"
DB_PATH="$DATA_DIR/orca.db"

if [ ! -f "$DB_PATH" ]; then
  echo "No database found at $DB_PATH"
  echo "Set ORCA_DATA_DIR if the daemon writes elsewhere."
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 not installed. Install it (e.g. 'sudo apt install sqlite3' / 'brew install sqlite')."
  exit 1
fi

BEFORE=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM agents WHERE connected = 1;")
sqlite3 "$DB_PATH" "UPDATE agents SET connected = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');"

echo "Cleared connected flag on $BEFORE agent(s) at $DB_PATH"
echo "Reload the app to see onboarding again."
