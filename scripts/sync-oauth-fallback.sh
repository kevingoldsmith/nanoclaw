#!/usr/bin/env bash
# Copy the current Claude Code OAuth access token from the macOS Keychain into
# .env as CLAUDE_CODE_OAUTH_TOKEN.
#
# Why this exists: container-runner prefers the Keychain token and only falls
# back to the .env value when the Keychain read or refresh fails. Because the
# Keychain token rotates every few hours, a hand-copied .env value goes stale
# almost immediately and the fallback quietly dies — surfacing only during a
# Keychain failure, when it is needed most. credential-expiry-watcher probes
# the fallback every 6h and points here when it is dead.
#
# This does NOT mint a token. If the Keychain itself is empty or expired, run
# `claude /login` on this machine first.
#
# Usage:  ./scripts/sync-oauth-fallback.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
KEY="CLAUDE_CODE_OAUTH_TOKEN"
SERVICE="Claude Code-credentials"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: Keychain is macOS-only; nothing to sync from." >&2
  exit 1
fi

[[ -f "$ENV_FILE" ]] || { echo "error: no .env at ${ENV_FILE}" >&2; exit 1; }

# Claude Code's /login writes an account-scoped entry; older NanoClaw builds
# wrote one with no account. Try both, same order as container-runner.
raw=""
for args in "-a ${USER}" ""; do
  # shellcheck disable=SC2086
  if raw=$(security find-generic-password -s "$SERVICE" $args -w 2>/dev/null); then
    [[ -n "$raw" ]] && break
  fi
done
[[ -n "$raw" ]] || { echo "error: no '${SERVICE}' entry in Keychain. Run 'claude /login'." >&2; exit 1; }

token=$(printf '%s' "$raw" | python3 -c \
  'import json,sys; print(json.load(sys.stdin).get("claudeAiOauth",{}).get("accessToken",""))')
[[ -n "$token" ]] || { echo "error: Keychain entry has no accessToken. Run 'claude /login'." >&2; exit 1; }

# Verify before writing — installing a token that is already dead would just
# re-arm the same trap this script exists to clear.
code=$(curl -sS -o /dev/null -w '%{http_code}' \
  'https://api.anthropic.com/v1/models?limit=1' \
  -H "Authorization: Bearer ${token}" \
  -H 'anthropic-version: 2023-06-01' || echo 000)
case "$code" in
  200) ;;
  401|403) echo "error: Keychain token is rejected (HTTP ${code}). Run 'claude /login' first." >&2; exit 1 ;;
  *)   echo "error: could not verify token (HTTP ${code}); refusing to write." >&2; exit 1 ;;
esac

backup="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup"

# Rewrite via a temp file in the same dir so the replace is atomic and the
# token never rides on a command line. Permissions are inherited from .env.
tmp=$(mktemp "${ENV_FILE}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
perms=$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null \
  || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)
chmod "$perms" "$tmp"

TOKEN_VALUE="$token" KEY_NAME="$KEY" python3 - "$ENV_FILE" "$tmp" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
key, value = os.environ['KEY_NAME'], os.environ['TOKEN_VALUE']
lines = open(src, encoding='utf-8').read().splitlines(keepends=True)
line = f'{key}={value}\n'
out, replaced = [], False
for raw in lines:
    if raw.split('=', 1)[0].strip() == key and not raw.lstrip().startswith('#'):
        if not replaced:
            out.append(line)
            replaced = True
        continue          # drop any duplicate definitions
    out.append(raw)
if not replaced:
    if out and not out[-1].endswith('\n'):
        out.append('\n')
    out.append(line)
open(dst, 'w', encoding='utf-8').write(''.join(out))
PY

mv -f "$tmp" "$ENV_FILE"
trap - EXIT

echo "✓ ${KEY} synced from Keychain (verified, HTTP 200)."
echo "  backup: ${backup}"
echo "  Note: the Keychain token rotates; this fallback will drift again."
echo "  Restart nanoclaw only if you want it reloaded immediately:"
echo "    launchctl kickstart -k gui/\$(id -u)/com.nanoclaw"
