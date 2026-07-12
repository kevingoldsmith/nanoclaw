# Gmail account3 — give it its own Testing-mode OAuth client (setup runbook)

**Status:** parked (2026-07-11), to do from a real workstation.
**Context:** account3 = `kevin@distrokid.com` (DistroKid Workspace).

## Why this is needed

- account3's Gmail refresh token was **revoked by a Google password change** (`invalid_grant: Token has been expired or revoked`) — re-auth is required.
- Re-auth hits a hard Google block: *"Google blocked it for your safety"* (no click-through). Cause: the **shared** Gmail/Calendar OAuth client (project `intense-hour-488316-n6`, client_id `639974594587-…`) is **"In production" but unverified**, and `gmail.modify` is a **restricted** scope. Google refuses *new* consent for restricted scopes on unverified production apps.
- We **cannot** fix it by flipping the shared client to Testing mode — it's shared with **account1 (kevin@nimbleautonomy.com, primary)** and **account2 (kevin.goldsmith@gmail.com)**; changing its mode would revoke/expire their Gmail too.
- We **cannot** quickly verify the app — restricted-scope verification (CASA) takes weeks.

**Fix:** mirror what Drive account3 already does — give Gmail account3 its **own** OAuth client in a **Testing-mode** project, isolated from account1/2. The rotation script (`scripts/rotate-account3.sh gmail`, built 2026-07-11) then handles the resulting 7-day refresh-token expiry.

## Steps

### 1. Create an isolated OAuth client (Google Cloud Console)

1. console.cloud.google.com → **create a new project**, e.g. `nanoclaw-gmail-account3` (dedicated, for isolation — do NOT reuse `intense-hour-488316-n6`).
2. **APIs & Services → Enable APIs** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - Publishing status: leave in **Testing**
   - **Scopes:** add `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/gmail.settings.basic`
   - **Test users:** add **`kevin@distrokid.com`**
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Desktop app**
   - Create, then **Download JSON** → this is the new `gcp-oauth.keys.json` (outer key will be `installed`).

### 2. Install the new keys on BOTH machines

The client must match on both, or token refresh fails. Target path (same on both):
`~/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json`

- **Mac Mini** — required: the container's Gmail MCP refreshes tokens using this file (agent-runner sets `GMAIL_OAUTH_PATH=/home/node/.gmail-account3/.gmail-mcp/gcp-oauth.keys.json`, mounted from this host path).
- **Laptop** — required only if you run the auth/rotation from the laptop.

Overwrite the old shared-client keys at that path with the new file.

### 3. Mint the first token (re-auth)

Because the new client is in **Testing** mode with `kevin@distrokid.com` as a test user, the consent screen will now show the *"Google hasn't verified this app"* warning **with** an **Advanced → Go to … (unsafe) → Continue** link — proceed and approve.

Either:
- **On the Mac Mini directly:**
  ```bash
  cd container/mcp-servers/gmail
  GMAIL_OAUTH_PATH=~/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json \
  GMAIL_CREDENTIALS_PATH=~/.gmail-mcp-account3/.gmail-mcp/credentials.json \
  npm run auth
  ```
- **Or from the laptop** (drops the token back via Dropbox → watcher):
  ```bash
  ./scripts/rotate-account3.sh gmail
  ```

### 4. Verify

```bash
python3 - <<'PY'
import json, urllib.request, urllib.parse
k=json.load(open('/Users/kevin/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json'))
k=k.get('installed') or k.get('web')
c=json.load(open('/Users/kevin/.gmail-mcp-account3/.gmail-mcp/credentials.json'))
d=urllib.parse.urlencode({'client_id':k['client_id'],'client_secret':k['client_secret'],
  'refresh_token':c['refresh_token'],'grant_type':'refresh_token'}).encode()
t=json.loads(urllib.request.urlopen('https://oauth2.googleapis.com/token',d).read())
print('refresh OK; refresh_token_expires_in =', t.get('refresh_token_expires_in','(absent)'))
PY
```
Expect `refresh OK` and `refresh_token_expires_in ≈ 604799` (7-day Testing-mode window — expected).

### 5. Ongoing

Testing mode = 7-day refresh expiry, so rotate weekly like Drive/Calendar:
`./scripts/rotate-account3.sh gmail` (moves the old creds aside to force a fresh 7-day token, encrypts, drops via Dropbox, watcher installs, Slack `✓`).

## Do NOT

- Touch the shared client `intense-hour-488316-n6` / `639974594587-…` — leave account1 & account2 alone.
- Reuse the Drive account3 client — Gmail needs its own scopes; keep them separate and legible.
