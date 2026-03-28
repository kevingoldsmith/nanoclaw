# Gmail Integration Setup Guide

Complete setup guide for adding Gmail accounts to NanoClaw using `@gongrzhe/server-gmail-autoauth-mcp`.

## Current Setup (2026-02-23)

**3 Gmail accounts configured:**
1. account1@example.com
2. account2@example.com
3. account3@example.com

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
mkdir -p ~/.gmail-mcp-account1/.npm
mkdir -p ~/.gmail-mcp-account2/.gmail-mcp
mkdir -p ~/.gmail-mcp-account2/.npm
mkdir -p ~/.gmail-mcp-account3/.gmail-mcp
mkdir -p ~/.gmail-mcp-account3/.npm
```

Copy OAuth credentials to each:
```bash
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account1/.gmail-mcp/
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account2/.gmail-mcp/
cp /path/to/gcp-oauth.keys.json ~/.gmail-mcp-account3/.gmail-mcp/
```

**Why `.npm/`?** The MCP package runs via `npx`, which needs a writable npm cache directory.

## OAuth Authorization (Per Account)

Authorize each account separately:

### Account 1
```bash
cd ~/.gmail-mcp-account1/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```
- Browser opens → sign in with **first Gmail account**
- If "Access blocked" appears → check test users list
- Click "Advanced" → "Go to NanoClaw (unsafe)" if needed
- Complete authorization

### Account 2
```bash
cd ~/.gmail-mcp-account2/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```
- Sign in with **second Gmail account**

### Account 3
```bash
cd ~/.gmail-mcp-account3/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```
- Sign in with **third Gmail account**

After authorization, each directory should have:
```
~/.gmail-mcp-accountN/
├── .gmail-mcp/
│   ├── credentials.json       ← Created during auth
│   └── gcp-oauth.keys.json    ← You copied this
└── .npm/                       ← npm cache
```

## Code Integration

### 1. Container Image (`container/Dockerfile`)
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @greirson/mcp-todoist @gongrzhe/server-gmail-autoauth-mcp
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
      readonly: false, // MCP may need to refresh tokens and write npm cache
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
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: { HOME: '/home/node/.gmail-account1' },
  },
  gmail_account2: {
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: { HOME: '/home/node/.gmail-account2' },
  },
  gmail_account3: {
    command: 'npx',
    args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    env: { HOME: '/home/node/.gmail-account3' },
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

### "EACCES: permission denied" on npm cache
→ Ensure `.npm/` directory exists on host: `mkdir -p ~/.gmail-mcp-accountN/.npm`

### "OAuth keys file not found"
→ Credentials must be in `$HOME/.gmail-mcp/gcp-oauth.keys.json`
→ Check mount path and HOME env var in MCP config

### Tools not available to agent
→ Verify package in Dockerfile
→ Check allowedTools includes `mcp__gmail_accountN__*`
→ Clear agent-runner cache: `rm -rf data/sessions/*/agent-runner-src`
→ Restart service

### MCP fails to start in container
→ Test manually: `docker exec [container] -e HOME=/home/node/.gmail-account1 npx @gongrzhe/server-gmail-autoauth-mcp`
→ Check container mounts: `docker inspect [container] | grep -A 3 gmail`

## Token Refresh

OAuth tokens may expire. To re-authorize:
```bash
rm ~/.gmail-mcp-accountN/.gmail-mcp/credentials.json
cd ~/.gmail-mcp-accountN/.gmail-mcp
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

## Adding More Accounts

To add a 4th, 5th, etc. account:
1. Create directory structure: `~/.gmail-mcp-account4/`
2. Copy OAuth keys
3. Authorize with new account
4. Add to for loop in `container-runner.ts`
5. Add MCP server config in `agent-runner/src/index.ts`
6. Add to allowedTools
7. Rebuild and restart

## Security Notes

- Credentials stored in `~/.gmail-mcp-accountN/.gmail-mcp/credentials.json`
- Not stored in `.env` or passed via environment variables
- Mounted read-write so MCP can refresh tokens
- Only accessible to container processes, not Bash subprocesses
