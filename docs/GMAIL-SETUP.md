# Gmail Integration Setup Guide

Complete setup guide for adding Gmail accounts to NanoClaw using the local fork at `container/mcp-servers/gmail/`.

**Why a local fork?** The upstream `@gongrzhe/server-gmail-autoauth-mcp` package does not persist refreshed OAuth tokens, requiring frequent re-authentication. The local fork at `container/mcp-servers/gmail/` fixes this: it uses explicit credential paths via env vars and automatically writes refreshed tokens back to disk.

## Current Setup (2026-02-23)

**3 Gmail accounts configured:**
1. kevin@nimbleautonomy.com (Nimble Autonomy)
2. kevin.goldsmith@gmail.com (Gmail)
3. kevin@distrokid.com (DistroKid)

**Mode:** Tool mode (read/send when asked via WhatsApp)

## Prerequisites

### 1. Google Cloud Project Setup

1. Go to https://console.cloud.google.com
2. Create new project (or use existing: `intense-hour-488316-n6`)
3. Enable Gmail API:
   - **APIs & Services → Library**
   - Search "Gmail API"
   - Click **Enable**

### 2. OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Configure OAuth consent screen if prompted:
   - Choose "External"
   - App name: "NanoClaw"
   - Add your email
   - Save
4. Select **Desktop app** as application type
5. Name it (e.g., "NanoClaw Gmail")
6. Click **Create**
7. Download JSON credentials → save as `gcp-oauth.keys.json`

### 3. Add Test Users

Since the app isn't published, you must add email addresses as test users:

1. Go to **APIs & Services → OAuth consent screen**
2. Scroll to **Test users** section
3. Click **+ ADD USERS**
4. Add all email addresses you want to authorize (one per line)
5. Click **SAVE**

⚠️ **Important:** Without adding test users, you'll get "Access blocked" errors during OAuth.

## Directory Structure Setup

For each Gmail account, create this structure:

```bash
mkdir -p ~/.gmail-mcp-account1/.gmail-mcp
mkdir -p ~/.gmail-mcp-account2/.gmail-mcp
mkdir -p ~/.gmail-mcp-account3/.gmail-mcp
```

Copy OAuth credentials to each:
```bash
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account1/.gmail-mcp/
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account2/.gmail-mcp/
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account3/.gmail-mcp/
```

## OAuth Authorization (Per Account)

Authorize each account separately using the local fork directly. Run these from the NanoClaw project root:

### Account 1
```bash
GMAIL_OAUTH_PATH="$HOME/.gmail-mcp-account1/.gmail-mcp/gcp-oauth.keys.json" \
  GMAIL_CREDENTIALS_PATH="$HOME/.gmail-mcp-account1/.gmail-mcp/credentials.json" \
  npx tsx container/mcp-servers/gmail/src/index.ts auth
```
- Browser opens → sign in with **first Gmail account**
- If "Access blocked" appears → check test users list
- Click "Advanced" → "Go to NanoClaw (unsafe)" if needed
- Complete authorization

### Account 2
```bash
GMAIL_OAUTH_PATH="$HOME/.gmail-mcp-account2/.gmail-mcp/gcp-oauth.keys.json" \
  GMAIL_CREDENTIALS_PATH="$HOME/.gmail-mcp-account2/.gmail-mcp/credentials.json" \
  npx tsx container/mcp-servers/gmail/src/index.ts auth
```
- Sign in with **second Gmail account**

### Account 3
```bash
GMAIL_OAUTH_PATH="$HOME/.gmail-mcp-account3/.gmail-mcp/gcp-oauth.keys.json" \
  GMAIL_CREDENTIALS_PATH="$HOME/.gmail-mcp-account3/.gmail-mcp/credentials.json" \
  npx tsx container/mcp-servers/gmail/src/index.ts auth
```
- Sign in with **third Gmail account**

After authorization, each directory should have:
```
~/.gmail-mcp-accountN/
├── .gmail-mcp/
│   ├── credentials.json       ← Created during auth
│   └── gcp-oauth.keys.json    ← You copied this
```

## Code Integration

### 1. Container Image (`container/Dockerfile`)

The local fork is copied and built during the container image build — it is not installed from npm:
```dockerfile
COPY mcp-servers/gmail /app/mcp-servers/gmail
RUN cd /app/mcp-servers/gmail && npm install && npm run build
```

### 2. Mount Credentials (`src/container-runner.ts`)
```typescript
// Gmail credentials for all 3 accounts
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
for (let i = 1; i <= 3; i++) {
  const gmailDir = path.join(homeDir, `.gmail-mcp-account${i}`);
  if (fs.existsSync(gmailDir)) {
    mounts.push({
      hostPath: gmailDir,
      containerPath: `/home/node/.gmail-account${i}`,
      readonly: false, // MCP writes refreshed tokens
    });
  }
}
```

### 3. MCP Server Config (`container/agent-runner/src/index.ts`)
```typescript
mcpServers: {
  nanoclaw: { /* ... */ },
  todoist: { /* ... */ },
  gmail_account1: {
    command: 'node',
    args: ['/app/mcp-servers/gmail/dist/index.js'],
    env: {
      GMAIL_OAUTH_PATH: '/home/node/.gmail-account1/.gmail-mcp/gcp-oauth.keys.json',
      GMAIL_CREDENTIALS_PATH: '/home/node/.gmail-account1/.gmail-mcp/credentials.json',
    },
  },
  gmail_account2: {
    command: 'node',
    args: ['/app/mcp-servers/gmail/dist/index.js'],
    env: {
      GMAIL_OAUTH_PATH: '/home/node/.gmail-account2/.gmail-mcp/gcp-oauth.keys.json',
      GMAIL_CREDENTIALS_PATH: '/home/node/.gmail-account2/.gmail-mcp/credentials.json',
    },
  },
  gmail_account3: {
    command: 'node',
    args: ['/app/mcp-servers/gmail/dist/index.js'],
    env: {
      GMAIL_OAUTH_PATH: '/home/node/.gmail-account3/.gmail-mcp/gcp-oauth.keys.json',
      GMAIL_CREDENTIALS_PATH: '/home/node/.gmail-account3/.gmail-mcp/credentials.json',
    },
  },
},
```

### 4. Allow Tools (`container/agent-runner/src/index.ts`)
```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*',
  'mcp__todoist__*',
  'mcp__gmail_account1__*',
  'mcp__gmail_account2__*',
  'mcp__gmail_account3__*'
],
```

### 5. Document in Memory (`groups/main/CLAUDE.md`)
Add section describing Gmail capabilities and which account is which email address.

### 6. Rebuild and Deploy
```bash
npm run build
./container/build.sh
rm -rf data/sessions/main/agent-runner-src
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Testing

Send WhatsApp message:
```
@Andy list my Gmail labels for account 1
```

Or:
```
@Andy check my recent emails on all 3 accounts
```

## Troubleshooting

### "Access blocked" during OAuth
→ Add email address to test users in OAuth consent screen

### "OAuth keys file not found"
→ Ensure `GMAIL_OAUTH_PATH` points to a valid file
→ Check that the `.gmail-mcp-accountN` directory was created and credentials were copied

### Tools not available to agent
→ Verify the local fork is built in Dockerfile
→ Check allowedTools includes `mcp__gmail_accountN__*`
→ Clear agent-runner cache: `rm -rf data/sessions/*/agent-runner-src`
→ Restart service

### MCP fails to start in container
→ Test manually: `docker exec [container] node /app/mcp-servers/gmail/dist/index.js`
→ Check container mounts: `docker inspect [container] | grep -A 3 gmail`

## Token Refresh

The local fork automatically refreshes and persists tokens. If a token expires or becomes invalid, re-authorize:
```bash
rm ~/.gmail-mcp-accountN/.gmail-mcp/credentials.json
GMAIL_OAUTH_PATH="$HOME/.gmail-mcp-accountN/.gmail-mcp/gcp-oauth.keys.json" \
  GMAIL_CREDENTIALS_PATH="$HOME/.gmail-mcp-accountN/.gmail-mcp/credentials.json" \
  npx tsx container/mcp-servers/gmail/src/index.ts auth
```

## Adding More Accounts

To add a 4th, 5th, etc. account:
1. Create directory structure: `~/.gmail-mcp-account4/`
2. Copy OAuth keys
3. Authorize with new account (using `npx tsx container/mcp-servers/gmail/src/index.ts auth` with appropriate env vars)
4. Add to for loop in `container-runner.ts`
5. Add MCP server config in `agent-runner/src/index.ts`
6. Add to allowedTools
7. Rebuild and restart

## Security Notes

- Credentials stored in `~/.gmail-mcp-accountN/.gmail-mcp/credentials.json`
- Not stored in `.env` or passed via environment variables
- Mounted read-write so MCP can refresh and persist tokens
- Only accessible to container processes, not Bash subprocesses
