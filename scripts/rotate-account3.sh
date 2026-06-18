#!/usr/bin/env bash
# Rotate account3 (DistroKid) Google MCP tokens from a laptop, encrypt with
# age, drop into the Dropbox folder watched by nanoclaw on the Mac Mini.
#
# Prereqs on this laptop:
#   - age (brew install age)
#   - Node + npx
#   - ~/.config/google-drive-mcp-account3/gcp-oauth.keys.json (OAuth client)
#   - ~/Dropbox/AndysDropBox/Account3/ exists and is syncing
#
# Usage:
#   ./rotate-account3.sh drive
#   ./rotate-account3.sh calendar

set -euo pipefail

# REPLACE WITH THE OUTPUT OF `age-keygen -y ~/.config/nanoclaw/age-identity.txt`
# (the public key — safe to commit; the private key stays on the Mac Mini).
RECIPIENT_PUBKEY="age19xd8clthrrumwvhwzzmutyln7237j9e2kj0ejw7kty5q5q296fgqy3cra0"

DROPBOX_DIR="${HOME}/Dropbox/AndysDropBox/Account3"

usage() {
  echo "Usage: $0 {drive|calendar}" >&2
  exit 2
}

[[ $# -eq 1 ]] || usage

SERVICE="$1"
case "${SERVICE}" in
  drive)
    TOKENS_PATH="${HOME}/.config/google-drive-mcp-account3/tokens.json"
    KEYS_PATH="${HOME}/.config/google-drive-mcp-account3/gcp-oauth.keys.json"
    AUTH_CMD=(env
      GOOGLE_DRIVE_OAUTH_CREDENTIALS="${KEYS_PATH}"
      GOOGLE_DRIVE_MCP_TOKEN_PATH="${TOKENS_PATH}"
      npx -y "@piotr-agier/google-drive-mcp@1.7.6" auth)
    ;;
  calendar)
    TOKENS_PATH="${HOME}/.config/google-calendar-mcp-account3/tokens.json"
    KEYS_PATH="${HOME}/.config/google-drive-mcp-account3/gcp-oauth.keys.json"
    AUTH_CMD=(env
      GOOGLE_CALENDAR_MCP_TOKEN_PATH="${TOKENS_PATH}"
      GOOGLE_OAUTH_CREDENTIALS="${KEYS_PATH}"
      npx -y "@cocal/google-calendar-mcp@2.6.1" auth)
    ;;
  *)
    usage
    ;;
esac

# Preflight
command -v age >/dev/null || { echo "age not installed (brew install age)"; exit 1; }
command -v npx >/dev/null || { echo "npx not installed"; exit 1; }
[[ -f "${KEYS_PATH}" ]] || { echo "Missing OAuth keys: ${KEYS_PATH}"; exit 1; }
[[ -d "${DROPBOX_DIR}" ]] || { echo "Missing Dropbox dir: ${DROPBOX_DIR}"; exit 1; }
[[ "${RECIPIENT_PUBKEY}" != age1XXXXXX* ]] || {
  echo "RECIPIENT_PUBKEY placeholder still in script — edit ${0} first."
  exit 1
}

# Per the OAuth playbook: move existing tokens aside so the auth flow does a
# full reissue, giving us a fresh 7-day refresh_token_expires_in window.
TS="$(date +%Y%m%dT%H%M%S)"
if [[ -f "${TOKENS_PATH}" ]]; then
  mv "${TOKENS_PATH}" "${TOKENS_PATH}.preauth-${TS}"
fi

# Run the auth flow (opens a browser).
"${AUTH_CMD[@]}"

[[ -f "${TOKENS_PATH}" ]] || { echo "auth did not produce ${TOKENS_PATH}"; exit 1; }
grep -q '"refresh_token"' "${TOKENS_PATH}" || {
  echo "tokens.json has no refresh_token — aborting"
  exit 1
}

OUT_NAME="tokens-account3-${SERVICE}.json.age"
OUT_PATH="${DROPBOX_DIR}/${OUT_NAME}"
TMP_PATH="${OUT_PATH}.tmp"

age -r "${RECIPIENT_PUBKEY}" -o "${TMP_PATH}" "${TOKENS_PATH}"
mv "${TMP_PATH}" "${OUT_PATH}"
sync || true

echo
echo "Dropped ${OUT_NAME} — expect Slack confirmation within 5 minutes."
echo "(File at: ${OUT_PATH})"
