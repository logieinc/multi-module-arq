#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-metro}"
shift || true

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/ops/dev-shell"
TSX_BIN="${TOOLS_DIR}/node_modules/.bin/tsx"

if [[ ! -x "${TSX_BIN}" ]]; then
  echo "Installing dev-shell tool dependencies..."
  npm --prefix "${TOOLS_DIR}" install --silent
fi

if [[ $# -eq 0 ]]; then
  "${TSX_BIN}" "${TOOLS_DIR}/src/cli.ts" up --profile "${PROFILE}"
else
  "${TSX_BIN}" "${TOOLS_DIR}/src/cli.ts" up --profile "${PROFILE}" -- "$@"
fi
