# Gmail account3 remote credential rotation — design

**Date:** 2026-07-11
**Status:** Approved (design)
**Author:** Kevin (via Claude Code, remote)

## Problem

Google **Drive** and **Calendar** for `account3` can be re-authed remotely (while
traveling, no inbound network to the Mac Mini) via `scripts/rotate-account3.sh`
+ the host-side credential-drop-watcher. **Gmail** `account3` cannot — its tokens
must currently be refreshed by hand on the Mac Mini.

Extend the exact same remote-rotation mechanism to cover Gmail `account3`.

## Constraints & findings

- **Container read path (ground truth):** the agent-runner sets, for account3,
  `GMAIL_CREDENTIALS_PATH=/home/node/.gmail-account3/.gmail-mcp/credentials.json`
  (`container/agent-runner/src/index.ts`). The container mount
  `-v /Users/kevin/.gmail-mcp-account3:/home/node/.gmail-account3` maps that to
  host path **`~/.gmail-mcp-account3/.gmail-mcp/credentials.json`** — the install
  target for the drop-watcher.
- **Token shape:** Gmail `credentials.json` is a flat object with a top-level
  `refresh_token`. The watcher's `validateTokensJson` already accepts a top-level
  `refresh_token`, so **no validator change is needed**.
- **Auth tool difference:** Drive/Calendar use *published* npx packages
  (`npx -y <pkg> auth`). Gmail uses a **local fork** at
  `container/mcp-servers/gmail/` whose auth flow is `npm run auth`
  (`npx tsx src/index.ts auth`), parameterized by `GMAIL_OAUTH_PATH` and
  `GMAIL_CREDENTIALS_PATH`. It runs a local callback server on `localhost:3000`.
- **Laptop has the repo:** the traveling laptop has a checkout of nanoclaw, so the
  script can run the local fork's auth resolved relative to the script location.
- **No new crypto:** same age recipient pubkey, same `AGE_IDENTITY_FILE` on the
  Mac Mini, same `CREDENTIAL_DROP_DIR`.

## Design (Approach A — extend the existing script + one mapping)

### 1. Drop-watcher mapping — `src/credential-drop-watcher.ts`

Add one entry to `MAPPING`:

```ts
'credentials-account3-gmail.json.age': {
  target: path.join(HOME, '.gmail-mcp-account3', '.gmail-mcp', 'credentials.json'),
  label: 'account3 gmail',
},
```

No change to `validateTokensJson` (top-level `refresh_token` already handled).
Change requires `npm run build` + launchd restart to take effect.

### 2. Rotate script — `scripts/rotate-account3.sh`

Add a `gmail` case. Because Gmail's filename prefix and auth command differ from
Drive/Calendar, the script parameterizes:

- **Output filename prefix:** drive/calendar → `tokens-account3-<svc>.json.age`;
  gmail → **`credentials-account3-gmail.json.age`** (must match the mapping key).
- **Auth command:** gmail runs the local fork resolved relative to the script:
  `SCRIPT_DIR/../container/mcp-servers/gmail`, invoked as
  `GMAIL_OAUTH_PATH=<keys> GMAIL_CREDENTIALS_PATH=<creds> npm run auth`.
- **Token path (the file that gets encrypted):** for gmail this is the laptop's
  `credentials.json` written by the auth flow.

Reuse the existing "move the old token file aside first, then run auth" step so
the consent flow issues a fresh `refresh_token` (fresh 7-day window).

### 3. Laptop prerequisites (script header + preflight validation)

Mirror how the `drive` case validates its OAuth keys:

- `container/mcp-servers/gmail/node_modules` present (run `npm install` there once);
  the fork's `auth` runs via `tsx`.
- Account3 Gmail OAuth client keys on the laptop, defaulting to the Mac-Mini-mirrored
  path **`~/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json`**; validated in
  preflight with a clear error if missing.

### 4. Docs

- Update the CLAUDE.md **Credential Drop Watcher** section: add the new file type
  to the mapping description and the remote re-auth example
  (`./scripts/rotate-account3.sh gmail`).
- Update the usage comment block at the top of `rotate-account3.sh`.

## Out of scope / unchanged

- No changes to the container, agent-runner, or MCP config — the container already
  reads the target path.
- No changes to age keys, identity file, or Dropbox drop directory.
- Only `account3` Gmail. accounts 1 & 2 are not rotated remotely (not requested).

## Data flow (end to end)

1. Laptop: `./scripts/rotate-account3.sh gmail` → moves old creds aside → runs the
   local fork's `auth` (browser consent) → writes a fresh `credentials.json`.
2. Script age-encrypts it to `credentials-account3-gmail.json.age` and drops it in
   the Dropbox-synced `CREDENTIAL_DROP_DIR`.
3. Dropbox syncs it to the Mac Mini.
4. Drop-watcher (≤5 min poll) decrypts with the age identity, validates
   `refresh_token`, atomically installs to
   `~/.gmail-mcp-account3/.gmail-mcp/credentials.json`, moves the source to
   `.processed/`, and posts a Slack confirmation (`✓ Installed account3 gmail tokens`).
5. Next container spawn picks up the fresh credentials.

## Error handling

- Missing OAuth keys / missing `node_modules` / auth not producing a
  `credentials.json` with `refresh_token` → script aborts before dropping anything
  (mirrors existing preflight in `rotate-account3.sh`).
- Invalid/undecryptable/malformed drop → watcher moves the file to
  `.errors/<ts>-<file>` with a `.reason` sidecar and posts a Slack warning
  (existing behavior, unchanged).

## Testing / verification

- Unit-ish: `lookupTarget('credentials-account3-gmail.json.age')` returns the Gmail
  target; `validateTokensJson` accepts a sample flat Gmail `credentials.json`.
- Manual dry-run of the script's preflight (bad/missing keys path) → clean abort.
- End-to-end (when convenient): run `./scripts/rotate-account3.sh gmail`, confirm the
  Slack `✓ Installed account3 gmail tokens` message within 5 minutes and that a
  subsequent Gmail action in a container succeeds.
