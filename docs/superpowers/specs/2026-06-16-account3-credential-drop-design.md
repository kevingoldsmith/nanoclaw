# Account3 Credential Drop Design

**Date:** 2026-06-16
**Status:** Approved
**Approach:** Host-side polling watcher in nanoclaw + laptop wrapper script + age encryption over Dropbox

## Context

Google Drive and Calendar for **account3** (kevin@distrokid.com) use a Testing-mode OAuth app, which gives refresh tokens a hard 7-day expiry. Re-auth requires a browser consent flow plus a `localhost:3000/oauth2callback` redirect — both of which run on the host the tokens live on.

This is fine while at home, but the user is traveling for a month soon and:

- **Cannot SSH or remote-access the Mac Mini.** The Mac Mini holds critical personal data unrelated to nanoclaw; exposing it (even via VPN/mesh) is not acceptable.
- **The Mac Mini can make outbound connections normally.** Only inbound is forbidden.
- **Account3 is used heavily during travel** — disabling it for the trip is not acceptable.

The trip is ~30 days, so ~4–5 re-auth cycles will happen remotely.

## Decisions

- **Transport: Dropbox.** Mac Mini polls a Dropbox folder; never accepts inbound connections.
- **Encryption: age.** Public-key crypto, public key on the laptop, private key only on the Mac Mini. Defense-in-depth over Dropbox's own encryption.
- **Watcher lives inside nanoclaw**, not as a separate launchd job. Avoids launchd sprawl and the user's concern about forgetting standalone services. The coupling argument (rotate even when nanoclaw is down) is weak in practice — MCP auth failures don't crash the host process, and a downed nanoclaw means the trip is broken regardless.
- **Polling, not `fs.watch`.** Five-minute interval. Sidesteps Dropbox's multi-event filename quirks; overhead is negligible for a once-a-week event.
- **Mapping is hardcoded.** Filename-to-target-path map in code; unknown filenames go to `.errors/`. Extending to "other files" later means adding a map entry.

## Architecture

```
LAPTOP                               DROPBOX (transport)         MAC MINI (nanoclaw)
┌─────────────────────────┐          ┌──────────────────┐        ┌──────────────────────────┐
│ rotate-account3.sh      │          │ Account3/        │        │ credential-drop-watcher  │
│                         │          │   tokens-...age  │        │   (in nanoclaw process)  │
│ 1. npx ... auth         │   sync   │   .processed/    │  sync  │                          │
│ 2. age -r <pubkey> ...  │ ───────► │   .errors/       │ ─────► │ every 5 min:             │
│ 3. cp to Dropbox        │          │                  │        │   decrypt → validate →   │
│                         │          │                  │        │   atomic rename →        │
│ pubkey baked in         │          │                  │        │   move source →          │
└─────────────────────────┘          └──────────────────┘        │   slack notify           │
                                                                  │                          │
                                                                  │ private key at:          │
                                                                  │   $AGE_IDENTITY_FILE     │
                                                                  └──────────────────────────┘
```

## Components

### Host watcher: `src/credential-drop-watcher.ts`

New module, ~60 lines. Single responsibility: drain the drop directory.

**Interface:**
- `start(): void` — called from `src/index.ts` alongside other host services. Registers a `setInterval` (5 min) and runs one tick immediately.
- `stop(): void` — clears the interval; called on shutdown.

**Per-tick behavior:**
1. List `*.age` files in `CREDENTIAL_DROP_DIR` (top level only — `.processed/` and `.errors/` are skipped).
2. For each file, in name-sorted order:
   a. Look up filename in the mapping table. Unknown → move to `.errors/<timestamp>-<filename>` with a `.reason` sidecar (`"no mapping for filename"`). Send Slack DM with reason.
   b. Decrypt with age (private key at `AGE_IDENTITY_FILE`). Failure → `.errors/` with reason, Slack DM.
   c. Parse decrypted bytes as JSON. Require a `refresh_token` field. Failure → `.errors/`, Slack DM.
   d. Atomic rename: write decrypted JSON to `<target>.tmp` (same directory as target, for same-FS rename), then `rename(<target>.tmp, <target>)`. Failure → leave source in drop dir for retry next tick (don't poison-pill on transient FS errors).
   e. Move source to `.processed/<timestamp>-<filename>`.
   f. Send Slack DM: `✓ Installed account3 <service> tokens (refresh expires <ISO date>)`. Expiry comes from `refresh_token_expires_in` if present, else "unknown".
3. The whole loop body runs inside try/catch; the watcher never dies on a bad file.

**Mapping table:**

```ts
const MAPPING: Record<string, { target: string; label: string }> = {
  'tokens-account3-drive.json.age': {
    target: '~/.config/google-drive-mcp-account3/tokens.json',
    label: 'account3 drive',
  },
  'tokens-account3-calendar.json.age': {
    target: '~/.config/google-calendar-mcp-account3/tokens.json',
    label: 'account3 calendar',
  },
};
```

`~` is expanded via `os.homedir()`. The map is the extensibility seam — new file types add one entry.

**Configuration (read from `.env`):**

| Variable | Default | Purpose |
|----------|---------|---------|
| `CREDENTIAL_DROP_DIR` | `~/Dropbox/AndysDropBox/Account3` | Watched directory |
| `AGE_IDENTITY_FILE` | `~/.config/nanoclaw/age-identity.txt` | Private key path (must be outside Dropbox) |
| `CREDENTIAL_DROP_INTERVAL_MS` | `300000` (5 min) | Poll interval; primarily for tests |

If `AGE_IDENTITY_FILE` does not exist at startup, the watcher logs a warning and does not start. This is a soft failure — nanoclaw starts normally; drops just don't get processed until the key is in place.

**Dependencies:**

- `age` decryption: use a pure-JS library to avoid a runtime CLI dependency. `age-encryption` (npm) implements the spec and has no native deps. The watcher imports it directly.

**Slack notifications:**

Sent via the existing host-side Slack send path (the same code path that sends `health notification` messages in `src/index.ts`). Target: the main/primary channel registered for nanoclaw. Format:

- Success: `✓ Installed <label> tokens (refresh expires <date>)`
- Failure: `⚠ Credential drop failed for <filename>: <reason>`

### Laptop script: `scripts/rotate-account3.sh`

Bash script run on the laptop. Args: `drive` or `calendar`.

**Behavior:**
1. Validate arg (one of `drive`, `calendar`).
2. Per the OAuth debugging playbook, move existing tokens.json aside so `auth` forces a full reissue with a fresh 7-day window: `mv tokens.json tokens.json.preauth-<timestamp>`.
3. Run the appropriate `npx ... auth` command. Drive uses `@piotr-agier/google-drive-mcp@1.7.6`; Calendar uses `@cocal/google-calendar-mcp@2.6.1`. Token paths and OAuth credential paths match those in memory and CLAUDE.md.
4. Verify the resulting tokens.json contains `refresh_token`. Abort if not.
5. Encrypt: `age -r <RECIPIENT_PUBKEY> -o tokens-account3-<service>.json.age tokens.json`.
6. Copy to `~/Dropbox/AndysDropBox/Account3/`. Use `cp` followed by `sync` so the encrypted file lands fully on disk before Dropbox starts uploading.
7. Log a one-line summary: `Dropped tokens-account3-<service>.json.age — expect Slack confirmation within 5 minutes.`

**Recipient pubkey:** Baked into the script as a constant. age recipient pubkeys are safe to commit (they're public keys); the private key lives only on the Mac Mini.

**Prerequisites on the laptop:** `age` binary in PATH, `npx`, Node, and a copy of the account3 OAuth client JSON at the expected path (`~/.config/google-drive-mcp-account3/gcp-oauth.keys.json`). The user will pre-stage these before traveling.

### Key generation: one-time setup

A one-shot command run before the first drop:

```bash
mkdir -p ~/.config/nanoclaw
age-keygen -o ~/.config/nanoclaw/age-identity.txt
# Prints the public key — copy this into rotate-account3.sh as RECIPIENT_PUBKEY
```

This is documented in the spec but not a separate script — it's run once and never again.

## Data flow (success path)

```
1. Laptop: ./rotate-account3.sh drive
   - Moves old tokens.json aside
   - npx ... auth → browser consent → tokens.json with fresh refresh_token_expires_in: 604799
   - age -r <pubkey> → tokens-account3-drive.json.age
   - cp to ~/Dropbox/AndysDropBox/Account3/

2. Dropbox: syncs file to Mac Mini (typically <30s)

3. Mac Mini (nanoclaw): next 5-min tick
   - Sees tokens-account3-drive.json.age
   - Decrypts with private key
   - Validates JSON has refresh_token
   - Atomic rename to ~/.config/google-drive-mcp-account3/tokens.json
   - Moves source to .processed/2026-06-16T14-32-15Z-tokens-account3-drive.json.age
   - Slack DM: ✓ Installed account3 drive tokens (refresh expires 2026-06-23)

4. Container: next drive_account3 MCP call reads the fresh tokens transparently.
```

## Error handling

| Failure mode | Action |
|---|---|
| Decrypt fails | Move to `.errors/`, sidecar reason, Slack DM with reason |
| JSON parse fails or missing `refresh_token` | Move to `.errors/`, sidecar reason, Slack DM |
| Unknown filename | Move to `.errors/`, sidecar reason, Slack DM |
| Atomic rename fails (e.g. EACCES, ENOSPC) | Leave in drop dir, log error, retry next tick. No Slack spam — if persistent, the user will notice the missing success notification. |
| Slack send fails | Log error; don't block the rest of the tick |
| Watcher loop body throws | Caught at the top of the tick, logged, next tick runs as normal |

The `.errors/` sidecar is a `.reason` file next to the moved encrypted file: e.g. `2026-06-16T14-32-15Z-tokens-account3-drive.json.age` and `2026-06-16T14-32-15Z-tokens-account3-drive.json.age.reason` containing the error message and stack.

## Security considerations

- **age private key never leaves the Mac Mini.** Path is configurable, defaults to `~/.config/nanoclaw/age-identity.txt`. Permissions should be `0600`. Spec doesn't enforce this, but the key-generation docs will recommend it.
- **Dropbox folder is encrypted-at-source.** Even if Dropbox is compromised, the contents are useless without the private key.
- **Atomic rename to target path** prevents readers (the container) from seeing a half-written file.
- **Validation before install** prevents installing garbage as tokens.json — a malformed file would otherwise break the MCP server until manual intervention.
- **Filename-based mapping** is a small attack surface; the watcher only writes to paths in the hardcoded map. Even with a write into the Dropbox folder, an attacker cannot redirect to an arbitrary path.

## Testing

### Unit tests
- `test/credential-drop-watcher.test.ts` covers:
  - Filename → target path mapping (known names, unknown names).
  - JSON validation (valid, missing refresh_token, malformed).
  - Decrypt with a fixture keypair (valid ciphertext, wrong-key ciphertext, garbage bytes).
  - Atomic rename: simulate target dir doesn't exist, simulate readonly target.
  - Error routing: each failure mode produces the right `.errors/` filename and sidecar content.

### Manual pre-trip drill
**This is the most important test.** Before traveling:
1. Generate the age keypair on the Mac Mini, bake the pubkey into the laptop script.
2. Run `./rotate-account3.sh drive` from the laptop.
3. Watch the nanoclaw logs and the Slack channel — confirm `✓ Installed` arrives within 5 minutes.
4. Verify the next drive_account3 MCP call works (e.g., ask nanoclaw to list a Drive folder).
5. Repeat for calendar.
6. Negative drill: drop a random file with `.age` extension — confirm it lands in `.errors/` with a useful reason and a Slack warning.

### Out of scope for testing
- Dropbox sync timing (relies on Dropbox itself; covered implicitly by the pre-trip drill).
- Slack delivery (existing send path; not new code).

## Out of scope

- **Heartbeat / liveness monitoring** — a separate piece of trip prep.
- **Mac Mini auto-restart configuration** — manual setup the user does outside this work.
- **Stuck-session recovery script** — separate piece of trip prep.
- **Anthropic OAuth token rotation** — could use the same infrastructure later; not built now.
- **Generalizing the mapping to allow arbitrary target paths** — YAGNI today, easy to extend later.
- **Restart signaling for the container** — not needed; tokens are re-read per MCP call.

## File changes summary

| File | Change |
|---|---|
| `src/credential-drop-watcher.ts` | New module |
| `src/index.ts` | Wire `start()` into host startup |
| `scripts/rotate-account3.sh` | New laptop wrapper script |
| `.env.example` | Add `CREDENTIAL_DROP_DIR`, `AGE_IDENTITY_FILE`, `CREDENTIAL_DROP_INTERVAL_MS` |
| `package.json` | Add `age-encryption` dependency |
| `test/credential-drop-watcher.test.ts` | New tests |
| `CLAUDE.md` | One-paragraph section documenting the watcher, configuration, and the laptop script's existence |
