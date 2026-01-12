#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

set -a
. "$ROOT_DIR/.env"
set +a

exec /usr/bin/env node dist/jobs/daily-generation.js
