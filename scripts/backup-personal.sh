#!/usr/bin/env bash
# Mirror NanoClaw's personal, gitignored config into a PRIVATE git repo so it
# has history and lives somewhere other than this disk.
#
# Why this exists: skills_for_nanoclaw/ and the per-group CLAUDE.md files are
# deliberately gitignored — this fork is public and they carry Kevin's name,
# work email domains and account mappings. That left them with no backup at
# all, and no history: trip-map silently moved from drive_account2 to
# drive_account1 at some unknown point, and nothing recorded it.
#
# This is a one-way mirror, not a working copy. The tree at REPO_ROOT stays the
# source of truth; this only ever copies *out*. Nothing in NanoClaw reads the
# mirror, so a failure here cannot affect the running system.
#
# Usage:  ./scripts/backup-personal.sh [--dry-run] [--no-push]
#           --dry-run   report what would change; write nothing
#           --no-push   sync and commit locally, but do not push

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MIRROR="${NANOCLAW_PRIVATE_MIRROR:-$HOME/nanoclaw-private}"
SLUG="kevingoldsmith/nanoclaw-private"

DRY_RUN=false
NO_PUSH=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --no-push) NO_PUSH=true ;;
    *) echo "error: unknown option '$arg'" >&2; exit 1 ;;
  esac
done

if [[ ! -d "$MIRROR/.git" ]]; then
  echo "error: no git repo at ${MIRROR}" >&2
  echo "  gh repo create ${SLUG} --private --clone" >&2
  exit 1
fi

# Hard guard. These files are personal by definition, so publishing them is the
# one unrecoverable failure mode here. Refuse to push to anything that is not
# demonstrably private — including when we simply cannot tell.
visibility=$(gh repo view "$SLUG" --json isPrivate --jq '.isPrivate' 2>/dev/null || echo "unknown")
if [[ "$visibility" != "true" ]]; then
  echo "error: ${SLUG} is not confirmed private (got: ${visibility}). Refusing." >&2
  exit 1
fi

# Allowlist, not an ignore list: only what is named here is ever copied, so a
# new secret appearing in the tree cannot be swept in by accident.
copy_file() {  # <relative path>
  local rel="$1" src="${REPO_ROOT}/$1" dst="${MIRROR}/$1"
  [[ -f "$src" ]] || return 0
  if $DRY_RUN; then echo "  would copy  $rel"; return 0; fi
  mkdir -p "$(dirname "$dst")"
  cp -p "$src" "$dst"
  echo "  copied      $rel"
}

echo "Mirroring into ${MIRROR}"

# 1. User skills. --delete so a skill removed upstream is removed here too;
#    scoped to this one subtree so it can never reach the rest of the mirror.
if [[ -d "${REPO_ROOT}/skills_for_nanoclaw" ]]; then
  count=$(ls -1 "${REPO_ROOT}/skills_for_nanoclaw" | wc -l | tr -d ' ')
  if $DRY_RUN; then
    echo "  would sync  skills_for_nanoclaw/ (${count} skills)"
  else
    mkdir -p "${MIRROR}/skills_for_nanoclaw"
    rsync -a --delete --exclude '.git' --exclude '.DS_Store' \
      "${REPO_ROOT}/skills_for_nanoclaw/" "${MIRROR}/skills_for_nanoclaw/"
    echo "  synced      skills_for_nanoclaw/ (${count} skills)"
  fi
fi

# 2. Per-group agent memory — the live instruction set each group runs on.
for dir in "${REPO_ROOT}"/groups/*/; do
  copy_file "groups/$(basename "$dir")/CLAUDE.md"
done

if $DRY_RUN; then echo "dry run — nothing written or committed."; exit 0; fi

# Belt and braces: never let a credential file reach the mirror, whatever the
# copy logic above did.
# `cut -c4-` strips the porcelain status prefix ("?? ", " M ") so the pattern
# matches the path, not the line. Anchoring to the raw line silently matches
# nothing — which is exactly how this guard failed its first test.
if git -C "$MIRROR" status --porcelain --untracked-files=all \
   | cut -c4- \
   | grep -qiE '(^|/)(\.env(\.|$)|credentials\.json|tokens\.json|gcp-oauth)'; then
  echo "error: a credential-shaped file reached the mirror. Aborting, nothing committed." >&2
  git -C "$MIRROR" status --short >&2
  exit 1
fi

if [[ -z "$(git -C "$MIRROR" status --porcelain)" ]]; then
  echo "No changes — mirror already current."
  exit 0
fi

echo "Changes:"
git -C "$MIRROR" status --short | sed 's/^/  /'

git -C "$MIRROR" add -A
git -C "$MIRROR" commit -q -m "backup: personal config $(date '+%Y-%m-%d %H:%M')"
short=$(git -C "$MIRROR" rev-parse --short HEAD)

if $NO_PUSH; then
  echo "✓ Committed ${short} locally (--no-push; nothing sent to ${SLUG})"
  exit 0
fi

git -C "$MIRROR" push -q origin HEAD
echo "✓ Pushed ${short} to ${SLUG}"
