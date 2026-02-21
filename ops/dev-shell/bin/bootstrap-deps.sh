#!/usr/bin/env bash
set -euo pipefail

PROFILE="${1:-metro}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TOOLS_DIR="${ROOT_DIR}/ops/dev-shell"
TSX_BIN="${TOOLS_DIR}/node_modules/.bin/tsx"

if [[ ! -x "${TSX_BIN}" ]]; then
  echo "Installing dev-shell tool dependencies..."
  npm --prefix "${TOOLS_DIR}" install --silent
fi

"${TSX_BIN}" "${TOOLS_DIR}/src/cli.ts" generate --profile "${PROFILE}" >/dev/null

STACK_ENV_FILE="${ROOT_DIR}/.generated/dev-shell/${PROFILE}/stack.env"
COMPOSE_FILE="${ROOT_DIR}/.generated/dev-shell/${PROFILE}/docker-compose.yaml"

mapfile -t SERVICES < <("${TSX_BIN}" "${TOOLS_DIR}/src/cli.ts" services --profile "${PROFILE}")

if [[ ${#SERVICES[@]} -eq 0 ]]; then
  echo "No enabled services found for profile ${PROFILE}" >&2
  exit 1
fi

echo "Installing dependencies inside containers for profile=${PROFILE}"
for svc in "${SERVICES[@]}"; do
  echo "  - ${svc}: npm install"
  docker compose --project-directory "${ROOT_DIR}" --env-file "${STACK_ENV_FILE}" -f "${COMPOSE_FILE}" run --rm -w "/workspace/repos/${svc}" "${svc}" npm install
done
