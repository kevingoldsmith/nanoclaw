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
**Package:** `@gongrzhe/server-gmail-autoauth-mcp`
**Type:** Stdio MCP (OAuth-based)
**Mode:** Tool mode (read/send when asked via WhatsApp)

**Accounts configured:**
1. **Account 1** (`gmail_account1`) - kevin@nimbleautonomy.com
2. **Account 2** (`gmail_account2`) - kevin.goldsmith@gmail.com
3. **Account 3** (`gmail_account3`) - kevin@distrokid.com

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

## Adding New MCP Integrations

### 1. Install Package in Container
Edit `container/Dockerfile`:
```dockerfile
RUN npm install -g agent-browser @anthropic-ai/claude-code @greirson/mcp-todoist your-new-package
```

### 2. Configure MCP Server in Agent Runner
Edit `container/agent-runner/src/index.ts` in the `mcpServers` section:

**For token-based MCPs:**
```typescript
yourService: {
  command: 'npx',
  args: ['-y', 'your-mcp-package'],
  env: { YOUR_API_TOKEN: sdkEnv.YOUR_API_TOKEN },
},
```

**For OAuth/credential-based MCPs:**
```typescript
yourService: {
  command: 'npx',
  args: ['-y', 'your-mcp-package'],
  env: { HOME: '/path/to/credentials' },
},
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
Edit `src/container-runner.ts` in `readSecrets()`:
```typescript
return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'YOUR_API_TOKEN']);
```

Also add to `SECRET_ENV_VARS` in `container/agent-runner/src/index.ts`:
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
