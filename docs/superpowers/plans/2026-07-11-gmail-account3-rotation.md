# Gmail account3 Remote Credential Rotation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `account3` Gmail credentials be re-authed remotely (from a traveling laptop, no inbound network to the Mac Mini) via the same age-encrypted-drop mechanism already used for Drive and Calendar.

**Architecture:** Add one `MAPPING` entry to the host-side credential-drop-watcher so it installs a dropped, age-encrypted Gmail `credentials.json` to the exact host path the container reads. Add a `gmail` case to `scripts/rotate-account3.sh` that runs the local Gmail MCP fork's `auth` flow on the laptop, age-encrypts the result, and drops it into the Dropbox-synced watch dir. No container/agent-runner/MCP-config changes — the container already reads the target path.

**Tech Stack:** TypeScript (Node, vitest), Bash, `age`, the local Gmail MCP fork (`container/mcp-servers/gmail`, run via `tsx`).

**Reference spec:** `docs/superpowers/specs/2026-07-11-gmail-account3-rotation-design.md`

---

## File Structure

- **Modify** `src/credential-drop-watcher.ts` — add one Gmail entry to `MAPPING`. (Responsibility unchanged: filename → install-target mapping is the security boundary.)
- **Modify** `src/credential-drop-watcher.test.ts` — add `lookupTarget` + `validateTokensJson` tests for the Gmail shape.
- **Modify** `scripts/rotate-account3.sh` — add `gmail` case + parameterize output-filename prefix and auth working-dir.
- **Modify** `CLAUDE.md` — document the new drop file type + rotate command.

Target host install path (ground truth from `container/agent-runner/src/index.ts` account3 env + the container mount): `~/.gmail-mcp-account3/.gmail-mcp/credentials.json`.

---

## Task 1: Add Gmail mapping to the credential-drop-watcher (TDD)

**Files:**
- Modify: `src/credential-drop-watcher.ts:13-33` (the `MAPPING` object)
- Test: `src/credential-drop-watcher.test.ts` (existing `lookupTarget` + `validateTokensJson` describe blocks)

- [ ] **Step 1: Write the failing tests**

In `src/credential-drop-watcher.test.ts`, inside the existing `describe('credential-drop-watcher: lookupTarget', ...)` block, add:

```ts
  it('maps gmail filename to the gmail credentials path', () => {
    const result = lookupTarget('credentials-account3-gmail.json.age');
    expect(result).toEqual({
      target: path.join(
        os.homedir(),
        '.gmail-mcp-account3',
        '.gmail-mcp',
        'credentials.json',
      ),
      label: 'account3 gmail',
    });
  });
```

And inside the existing `describe('credential-drop-watcher: validateTokensJson', ...)` block, add a test proving the flat Gmail shape passes:

```ts
  it('accepts a flat Gmail credentials.json (top-level refresh_token)', () => {
    const buf = Buffer.from(
      JSON.stringify({
        access_token: 'ya29.example',
        refresh_token: '1//example-refresh',
        scope: 'https://www.googleapis.com/auth/gmail.modify',
        token_type: 'Bearer',
        expiry_date: 1783555490203,
      }),
    );
    expect(validateTokensJson(buf)).toEqual({ ok: true });
  });
```

- [ ] **Step 2: Run the tests to verify the new `lookupTarget` test fails**

Run: `npx vitest run src/credential-drop-watcher.test.ts -t "maps gmail filename"`
Expected: FAIL — `lookupTarget` returns `null` (no mapping yet), so `expect(...).toEqual(...)` fails with `null` vs the object. (The `validateTokensJson` test will already PASS, since a top-level `refresh_token` is already accepted — that's expected and documents the guarantee.)

- [ ] **Step 3: Add the Gmail mapping entry**

In `src/credential-drop-watcher.ts`, add a third entry to `MAPPING` (after the `calendar` entry, before the closing `};` at line 33):

```ts
  'credentials-account3-gmail.json.age': {
    target: path.join(
      HOME,
      '.gmail-mcp-account3',
      '.gmail-mcp',
      'credentials.json',
    ),
    label: 'account3 gmail',
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/credential-drop-watcher.test.ts`
Expected: PASS — all existing tests plus the two new ones green.

- [ ] **Step 5: Commit**

```bash
git add src/credential-drop-watcher.ts src/credential-drop-watcher.test.ts
git commit -m "feat(rotation): map account3 gmail credential drop to install path"
```

---

## Task 2: Add the `gmail` case to `scripts/rotate-account3.sh`

**Files:**
- Modify: `scripts/rotate-account3.sh` (usage comment, `SCRIPT_DIR`/`REPO_ROOT`, defaults, `case`, preflight, auth invocation, `OUT_NAME`)

This script has no unit-test harness (consistent with the repo). Verification is `bash -n` syntax check + a preflight dry-run that aborts before the browser step.

- [ ] **Step 1: Add repo-root resolution and per-service defaults**

Immediately after `set -euo pipefail` (line 15), add:

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults; the gmail case overrides these.
OUT_PREFIX="tokens"
AUTH_DIR=""
```

- [ ] **Step 2: Update the usage helper to include gmail**

Change the `usage()` body (line 24) from:

```bash
  echo "Usage: $0 {drive|calendar}" >&2
```
to:
```bash
  echo "Usage: $0 {drive|calendar|gmail}" >&2
```

- [ ] **Step 3: Add the `gmail` case**

In the `case "${SERVICE}" in` block, add this case after the `calendar)` case and before the `*)` fallback:

```bash
  gmail)
    OUT_PREFIX="credentials"
    GMAIL_DIR="${REPO_ROOT}/container/mcp-servers/gmail"
    TOKENS_PATH="${HOME}/.gmail-mcp-account3/.gmail-mcp/credentials.json"
    KEYS_PATH="${HOME}/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json"
    AUTH_DIR="${GMAIL_DIR}"
    AUTH_CMD=(env
      GMAIL_OAUTH_PATH="${KEYS_PATH}"
      GMAIL_CREDENTIALS_PATH="${TOKENS_PATH}"
      npm run --silent auth)
    ;;
```

- [ ] **Step 4: Add the gmail node_modules preflight check**

After the existing preflight block (right after the `RECIPIENT_PUBKEY` placeholder check, ~line 61), add:

```bash
if [[ "${SERVICE}" == "gmail" ]]; then
  [[ -d "${GMAIL_DIR}/node_modules" ]] || {
    echo "Missing ${GMAIL_DIR}/node_modules — run 'npm install' in that dir first."
    exit 1
  }
fi
```

- [ ] **Step 5: Make the auth invocation run in the right working dir**

Replace the single auth-run line (line 71, `"${AUTH_CMD[@]}"`) with:

```bash
# Run the auth flow (opens a browser). gmail runs inside the local fork dir so
# `npm run auth` resolves the fork's tsx + entrypoint; drive/calendar run in place.
if [[ -n "${AUTH_DIR}" ]]; then
  ( cd "${AUTH_DIR}" && "${AUTH_CMD[@]}" )
else
  "${AUTH_CMD[@]}"
fi
```

- [ ] **Step 6: Parameterize the output filename**

Change the `OUT_NAME` line (line 79) from:

```bash
OUT_NAME="tokens-account3-${SERVICE}.json.age"
```
to:
```bash
OUT_NAME="${OUT_PREFIX}-account3-${SERVICE}.json.age"
```

- [ ] **Step 7: Update the usage comment header**

In the top comment block, change the `# Usage:` examples (lines 11-13) to include gmail:

```bash
# Usage:
#   ./rotate-account3.sh drive
#   ./rotate-account3.sh calendar
#   ./rotate-account3.sh gmail
#
# gmail prereqs (in addition to the above): this repo checked out on the laptop,
# and `npm install` run once in container/mcp-servers/gmail. The gmail OAuth
# client keys must be at ~/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json.
```

- [ ] **Step 8: Syntax-check the script**

Run: `bash -n scripts/rotate-account3.sh`
Expected: no output, exit code 0 (no syntax errors).

- [ ] **Step 9: Verify preflight aborts cleanly for an unconfigured gmail run**

This confirms the new case wires up without launching a browser. Temporarily point at a non-existent keys path to exercise the abort:

Run: `bash -c 'set -e; HOME=/tmp/nc-rotate-test bash scripts/rotate-account3.sh gmail'`
Expected: FAIL fast with `Missing OAuth keys: /tmp/nc-rotate-test/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json` (the existing `[[ -f "${KEYS_PATH}" ]]` preflight), exit code 1. No browser opens. (If `/tmp/nc-rotate-test` happens to exist with keys, use any other empty dir.)

- [ ] **Step 10: Commit**

```bash
git add scripts/rotate-account3.sh
git commit -m "feat(rotation): add gmail case to rotate-account3.sh"
```

---

## Task 3: Document the new drop type in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md` (the "Credential Drop Watcher" section — the "Remote re-auth from the laptop" example and the "Adding new file types" note)

- [ ] **Step 1: Add the gmail command to the remote re-auth example**

In `CLAUDE.md`, find the fenced block under **Remote re-auth from the laptop:**:

```bash
./scripts/rotate-account3.sh drive
./scripts/rotate-account3.sh calendar
```
Replace it with:
```bash
./scripts/rotate-account3.sh drive
./scripts/rotate-account3.sh calendar
./scripts/rotate-account3.sh gmail
```

- [ ] **Step 2: Note the gmail file type / prefix**

In the same section, immediately after the fenced block from Step 1, add:

```markdown
Gmail account3 uses the same flow. Its drop file is `credentials-account3-gmail.json.age`
(note the `credentials-` prefix vs `tokens-` for Drive/Calendar) and installs to
`~/.gmail-mcp-account3/.gmail-mcp/credentials.json`. The gmail auth step runs the local
fork in `container/mcp-servers/gmail`, so the laptop needs this repo checked out and
`npm install` run once in that dir.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document gmail account3 remote rotation"
```

---

## Task 4: Build, test, deploy (build → verify → graceful restart → confirm)

**Files:** none (deploy step). The drop-watcher runs inside the NanoClaw process, so the compiled `dist/` must be rebuilt and the launchd service restarted to load the new mapping.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass, including the new `credential-drop-watcher` tests.

- [ ] **Step 3: Graceful restart of the NanoClaw service**

The shutdown handler detaches (does not kill) in-flight containers, and this remote-control session is independent of the service, so this is safe to run remotely.

Run: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
Expected: command returns; a new `com.nanoclaw` PID appears.

- [ ] **Step 4: Confirm the service came back healthy**

Run: `launchctl list | grep nanoclaw && tail -n 20 ~/Library/Logs/nanoclaw/nanoclaw.log`
Expected: `com.nanoclaw` present with a fresh PID; recent log lines show normal startup (Slack connected, no crash loop, no new stack traces).

- [ ] **Step 5: (End-to-end, when convenient from the laptop) Confirm the round trip**

From the laptop: `./scripts/rotate-account3.sh gmail`, complete the browser consent.
Expected within 5 minutes: Slack message `✓ Installed account3 gmail tokens`, and the source file moved to `.processed/` in the drop dir. A subsequent Gmail action in a container succeeds. (This step needs the laptop + browser, so it may be deferred; Tasks 1–4 are the code/deploy work.)

---

## Self-Review

**Spec coverage:**
- Spec §Design.1 (watcher mapping, no validator change) → Task 1. ✓
- Spec §Design.2 (rotate script gmail case, filename prefix, auth cmd, move-aside reused) → Task 2 (move-aside is the script's existing pre-auth step, unchanged and applies to gmail via `TOKENS_PATH`). ✓
- Spec §Design.3 (laptop prereqs: node_modules + OAuth keys path) → Task 2 Step 4 (node_modules) + existing `[[ -f "${KEYS_PATH}" ]]` preflight (keys), documented in Step 7. ✓
- Spec §Design.4 (docs) → Task 3. ✓
- Spec §Data flow / deploy (build + launchd restart to load mapping) → Task 4. ✓
- Spec §Testing → Task 1 (unit) + Task 2 Step 9 (preflight) + Task 4 Step 5 (e2e). ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete content. ✓

**Type/name consistency:** Drop filename `credentials-account3-gmail.json.age` is identical in Task 1 (mapping + test), Task 2 (`OUT_PREFIX="credentials"` → `${OUT_PREFIX}-account3-${SERVICE}.json.age`), and Task 3 (docs). Target path `~/.gmail-mcp-account3/.gmail-mcp/credentials.json` is identical in Task 1, Task 2 (`TOKENS_PATH`), and Task 3. `label: 'account3 gmail'` consistent. ✓
