# NanoClaw Integrations

This document describes the currently configured MCP integrations and how to add new ones.

## Active Integrations

### Todoist
**Package:** `@greirson/mcp-todoist`
**Type:** Stdio MCP (API token-based)
**Configuration:** `.env` file → `TODOIST_API_TOKEN`

**Tools available:**
- Task management (add, update, complete, search by date/criteria)
- Project management (create, update, archive)
- Section management
- Comments and collaboration
- Activity logging
- Bulk assignment operations

**Usage examples:**
- "What's on my Todoist today?"
- "Add a task to review the PR tomorrow"
- "Show me completed tasks from this week"

### Gmail (3 accounts)
**Package:** Local fork at `container/mcp-servers/gmail/` (built into container image)
**Type:** Stdio MCP (OAuth-based)
**Mode:** Tool mode (read/send when asked via WhatsApp)

**Key improvement over upstream:** Auto-persists refreshed OAuth tokens, so re-authentication is rarely needed.

**Accounts configured:**
1. **Account 1** (`gmail_account1`) - kevin@nimbleautonomy.com (Nimble Autonomy)
2. **Account 2** (`gmail_account2`) - kevin.goldsmith@gmail.com (Gmail)
3. **Account 3** (`gmail_account3`) - kevin@distrokid.com (DistroKid)

**Tools available per account:**
- `search_emails` - Search with Gmail query syntax
- `get_email` - Fetch full email content
- `send_email` - Send emails
- `draft_email` - Create drafts
- `list_labels` - List Gmail labels
- `create_label`, `modify_labels` - Label management
- `get_profile` - Get account info

**Usage examples:**
- "Check my recent emails on the DistroKid account"
- "Search for unread emails from john@example.com in my personal Gmail"
- "Send an email from my Nimble Autonomy account to..."

**Directory structure:**
```
~/.gmail-mcp-account1/
├── .gmail-mcp/
│   ├── credentials.json
│   └── gcp-oauth.keys.json
└── .npm/
```

**OAuth setup:**
- GCP project: `intense-hour-488316-n6`
- OAuth app: NanoClaw (Desktop app)
- Test users: all 3 email addresses added
- Credentials downloaded and placed in each account directory

**Authorization:**
```bash
GMAIL_OAUTH_PATH="$HOME/.gmail-mcp-account1/.gmail-mcp/gcp-oauth.keys.json" \
  GMAIL_CREDENTIALS_PATH="$HOME/.gmail-mcp-account1/.gmail-mcp/credentials.json" \
  npx tsx container/mcp-servers/gmail/src/index.ts auth
```

See [GMAIL-SETUP.md](GMAIL-SETUP.md) for full setup details.

### Google Calendar (3 accounts)
**Package:** `@cocal/google-calendar-mcp@2.6.1`
**Type:** Stdio MCP (OAuth-based)
**Configuration:** OAuth credentials via env vars (file path, not JSON content)

**Accounts configured:**
1. **Account 1** (`calendar_account1`) - kevin@nimbleautonomy.com (Nimble Autonomy)
2. **Account 2** (`calendar_account2`) - kevin.goldsmith@gmail.com (Gmail)
3. **Account 3** (`calendar_account3`) - kevin@distrokid.com (DistroKid)

**Container env vars per account:**
- `GOOGLE_OAUTH_CREDENTIALS` = `/home/node/.calendar-creds-accountN/gcp-oauth.keys.json`
- `GOOGLE_CALENDAR_MCP_TOKEN_PATH` = `/home/node/.config/google-calendar-mcp-accountN/tokens.json`

**Token storage (host):**
```
~/.config/google-calendar-mcp/tokens.json           # Account 1
~/.config/google-calendar-mcp-account2/tokens.json  # Account 2
~/.config/google-calendar-mcp-account3/tokens.json  # Account 3
```

**Authorization:**
```bash
# Account 1
GOOGLE_OAUTH_CREDENTIALS="/Users/kevin/.gmail-mcp-account1/.gmail-mcp/gcp-oauth.keys.json" \
  npx @cocal/google-calendar-mcp auth

# Account 2
GOOGLE_OAUTH_CREDENTIALS="/Users/kevin/.gmail-mcp-account2/.gmail-mcp/gcp-oauth.keys.json" \
  GOOGLE_CALENDAR_MCP_TOKEN_PATH="/Users/kevin/.config/google-calendar-mcp-account2/tokens.json" \
  npx @cocal/google-calendar-mcp auth
```

**Important:** `GOOGLE_OAUTH_CREDENTIALS` must be a file path, not JSON content.

### Google Drive (3 accounts)
**Package:** `@piotr-agier/google-drive-mcp@1.7.6`
**Type:** Stdio MCP (OAuth-based)
**Configuration:** Reuses same GCP OAuth credentials as Gmail/Calendar

**Accounts configured:**
1. **Account 1** (`drive_account1`) - kevin@nimbleautonomy.com
2. **Account 2** (`drive_account2`) - kevin.goldsmith@gmail.com
3. **Account 3** (`drive_account3`) - kevin@distrokid.com

**Token storage (host):**
```
~/.config/google-drive-mcp-account1/tokens.json
~/.config/google-drive-mcp-account2/tokens.json
~/.config/google-drive-mcp-account3/tokens.json
```

**Authorization:**
```bash
GOOGLE_DRIVE_OAUTH_CREDENTIALS="$HOME/.gmail-mcp-accountN/.gmail-mcp/gcp-oauth.keys.json" \
  GOOGLE_DRIVE_MCP_TOKEN_PATH="$HOME/.config/google-drive-mcp-accountN/tokens.json" \
  npx @piotr-agier/google-drive-mcp auth
```

### Check-in App
**Package:** Local MCP server at `container/mcp-servers/checkin/` (built into container image)
**Type:** Stdio MCP (OAuth2 client credentials)
**Configuration:** `.env` file → `CHECKIN_APP_TOKEN_ENDPOINT`, `CHECKIN_APP_AGENT_CLIENT_ID`, `CHECKIN_APP_SECRET`, `CHECKIN_APP_API`

**API:** Kevin's own check-in app. The server POSTs to the Cognito token
endpoint for a short-lived access token, then calls `GET /checkins/latest`.
Tokens are cached in memory until 60s before expiry and are never written to
disk.

**Scope:** The agent credential holds `checkin-api/latest.read` and nothing
else. It reaches `GET /checkins/latest` only — a **403 on any other route
(including `POST /diagnostics`, which exposes full GPS) is the design working**,
not a bug. Rotating or revoking this client in Cognito cuts the agent off
without touching Kevin's own app login. The secret lives only in `.env` on the
host; it is never committed to this repo or shared with the client app.

**Tools available:**
- `get_last_checkin` - The most recent check-in (place, locality, coordinates, note, `created_at`)

**Response shape:** `checkin_id`, `place_id`, `place_name`, `place_lat`,
`place_lon`, `locality`, `country`, `note`, `created_at`. Nothing else — there
is no check-in history endpoint, so there is no "recent check-ins" tool.

**Empty state:** An empty table returns HTTP 404 `{"detail":"no check-ins yet"}`.
The server treats this as an ordinary outcome and reports "No check-ins yet",
not an error.

**Freshness:** `created_at` is the honest signal. A check-in is where Kevin last
*chose* to check in, possibly days ago. The tool output instructs the agent to
phrase answers with the timestamp.

**Container path:** `/app/mcp-servers/checkin/dist/index.js`

**Usage examples:**
- "Where did Kevin last check in?"
- "Where is Kevin?" → answered as "last checked in at X on <time>"

### Joplin Notes
**Package:** `joplin-mcp-server@2.1.0`
**Type:** Stdio MCP (API token + HTTP to Joplin desktop)
**Configuration:** `.env` file → `JOPLIN_TOKEN`

**Container env vars:**
- `JOPLIN_TOKEN` — API token from Joplin desktop app
- `JOPLIN_HOST` — `host.docker.internal` (reaches macOS host from container)
- `JOPLIN_PORT` — `41184` (default Joplin API port)

**Requirements:** Joplin desktop must be running on the host with the Web Clipper / API enabled.

**Usage examples:**
- "Search my Joplin notes for..."
- "Create a note in Joplin"

### DistroKid Slack
**Package:** Binary at `container/bin/slack-mcp-server` (installed in container image)
**Type:** Stdio MCP (xoxc/xoxd tokens)
**Configuration:** `.env` file → `SLACK_MCP_XOXC_TOKEN`, `SLACK_MCP_XOXD_TOKEN`

**Usage examples:**
- "Check the #releases channel in Slack"
- "What's been posted in Slack today?"

### Open Brain (+ companion servers)
**Type:** HTTP MCP servers (all share the same `OPEN_BRAIN_KEY` and base URL)
**Configuration:** `.env` file → `OPEN_BRAIN_KEY`, `OPEN_BRAIN_URL`

**Servers configured** (URLs derived by replacing `open-brain-mcp` in `OPEN_BRAIN_URL`):
| MCP name | URL suffix | Purpose |
|---|---|---|
| `open_brain` | `open-brain-mcp` | Capture and search thoughts |
| `family_calendar` | `family-calendar-mcp` | Family schedule |
| `home_maintenance` | `home-maintenance-mcp` | Home maintenance tasks |
| `household_knowledge` | `household-knowledge-mcp` | Household items and vendors |
| `meal_planning` | `meal-planning-mcp` | Recipes and meal plans |
| `professional_crm` | `professional-crm-mcp` | Professional contacts and follow-ups |

All use `x-access-key` header except `open_brain` which uses `x-brain-key`.

## Adding New MCP Integrations

### 1. Install Package in Container
Edit `container/Dockerfile`:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @greirson/mcp-todoist your-new-package
```

For local MCP servers, add a `COPY` + build step instead:
```dockerfile
COPY mcp-servers/your-server /app/mcp-servers/your-server
RUN cd /app/mcp-servers/your-server && npm install && npm run build
```

### 2. Configure MCP Server in Agent Runner
Edit `container/agent-runner/src/index.ts` in the `mcpServers` section:

**For token-based MCPs:**
```typescript
...(sdkEnv.YOUR_API_TOKEN ? {
  yourService: {
    command: 'npx',
    args: ['-y', 'your-mcp-package'],
    env: { YOUR_API_TOKEN: sdkEnv.YOUR_API_TOKEN },
  },
} : {}),
```

**For HTTP MCPs:**
```typescript
...(sdkEnv.YOUR_KEY ? {
  yourService: {
    type: 'http' as const,
    url: sdkEnv.YOUR_SERVICE_URL,
    headers: { 'x-api-key': sdkEnv.YOUR_KEY },
  },
} : {}),
```

### 3. Add to Allowed Tools
In the same file, add to `allowedTools`:
```typescript
'mcp__yourService__*',
```

### 4. Mount Credentials (if needed)
Edit `src/container-runner.ts` in `buildVolumeMounts()`:
```typescript
const credDir = path.join(homeDir, '.your-service');
if (fs.existsSync(credDir)) {
  mounts.push({
    hostPath: credDir,
    containerPath: '/home/node/.your-service',
    readonly: false,
  });
}
```

### 5. Pass Secrets (if needed)
Edit `src/container-runner.ts` in `buildContainerArgs()` — add the key to the `readEnvFile()` call:
```typescript
const mcpSecrets = readEnvFile([
  'TODOIST_API_TOKEN',
  'YOUR_API_TOKEN',   // <-- add here
  // ...
]);
```

Also add to `SECRET_ENV_VARS` in `container/agent-runner/src/index.ts` so the secret is stripped from Bash subprocess environments:
```typescript
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'YOUR_API_TOKEN'];
```

### 6. Document in Group Memory
Edit `groups/main/CLAUDE.md` to add the new capabilities.

### 7. Rebuild and Restart
```bash
npm run build                                # Compile TypeScript
./container/build.sh                         # Rebuild container image
rm -rf data/sessions/*/agent-runner-src      # Clear cached agent code
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # Restart service (macOS)
# systemctl --user restart nanoclaw          # Restart service (Linux)
```

## Testing New Integrations

1. Send a WhatsApp message: `@Andy test the [service] integration`
2. Check container logs for errors: `groups/main/logs/container-*.log`
3. Verify tools are available: Ask Andy to list available tools or use a specific one

## Troubleshooting

**MCP server not loading:**
- Check container logs: `tail -f ~/Library/Logs/nanoclaw/nanoclaw.log`
- Verify credentials are mounted: `docker inspect [container-name]`
- Test MCP manually: `docker exec [container] npx your-mcp-package`

**Permission errors:**
- Ensure writable directories exist on host (e.g., `.npm/` for npm cache)
- Check mount is read-write: `readonly: false`

**Tools not appearing:**
- Verify package installed in container: check `container/Dockerfile`
- Verify allowedTools includes the pattern: check `container/agent-runner/src/index.ts`
- Clear agent-runner cache and restart

## Future Enhancements

### Gmail: Email Triggering (Allowlist Mode)
Not yet implemented. Would allow specific senders to trigger Andy via email instead of just tool access from WhatsApp.

**Requirements:**
- Email polling loop in `src/index.ts`
- Sender allowlist configuration
- Thread/sender-based context routing
