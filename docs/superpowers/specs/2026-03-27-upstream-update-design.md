# NanoClaw Upstream Update Design

**Date:** 2026-03-27
**Status:** Approved
**Approach:** Rebase-and-reapply (reset to upstream, re-apply customizations)

## Context

The local fork is 384 commits behind `origin/main` (upstream). Upstream has made major architectural changes:

- **OneCLI Agent Vault** replaces `.env`-based secret injection (`readSecrets`, `SECRET_ENV_VARS` removed)
- **Channel registry** replaces direct channel imports (`getChannelFactory` pattern)
- **Built-in logger** replaces pino/pino-pretty (no rotation — add later)
- **Skills engine** — new system for applying/managing skills
- **Task scripts** — scheduled tasks can include executable scripts
- **Message history overflow protection** — prevents full history sent to containers

A `git merge` is not viable due to structural conflicts in every core file. Instead, we reset to upstream and surgically re-apply local customizations using the new patterns.

## Decisions

- **Adopt OneCLI** for secret management (migrate all credentials from `.env`)
- **Adopt upstream's built-in logger** — add rotation as a separate concern later
- **Slack is the primary channel** — WhatsApp is unused (auth lockout)
- **Local MCP servers stay in `container/mcp-servers/`** — upstream doesn't touch this directory; conflict surface is only Dockerfile and agent-runner config
- **Backup branch** (`pre-update-backup`) preserves full pre-update state for rollback

## Customizations to Preserve

### Integrations (12)

| # | Integration | Type | Secret Mechanism |
|---|------------|------|-----------------|
| 1 | Slack channel | `src/channels/slack.ts` + `@slack/bolt` | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` |
| 2 | Gmail (3 accounts) | Local fork `container/mcp-servers/gmail/` | OAuth tokens (mounted) |
| 3 | Google Calendar (3 accounts) | `@cocal/google-calendar-mcp` | OAuth tokens (mounted) |
| 4 | Google Drive (3 accounts) | `@piotr-agier/google-drive-mcp` | OAuth tokens (mounted) |
| 5 | Todoist | `@greirson/mcp-todoist` | `TODOIST_API_TOKEN` |
| 6 | Foursquare/Swarm | Local `container/mcp-servers/foursquare/` | `FOURSQUARE_TOKEN` |
| 7 | Joplin | `joplin-mcp-server` | `JOPLIN_TOKEN` |
| 8 | DistroKid Slack | `container/bin/slack-mcp-server` binary | `SLACK_MCP_XOXC_TOKEN`, `SLACK_MCP_XOXD_TOKEN` |
| 9 | Open Brain (+5 companions) | HTTP MCP | `OPEN_BRAIN_KEY`, `OPEN_BRAIN_URL` |
| 10 | OpenAI Whisper | `openai` package | `OPENAI_API_KEY` |

### Features (8)

1. **Progress streaming** — agent-runner emits short text as progress; host forwards to Slack threads
2. **Skill model override** — `detectSkillModel()` reads SKILL.md frontmatter `model:` field
3. **Weekly session rotation** — Sundays 4am, `archived_sessions` table, prevents context bloat
4. **Cross-channel health notifications** — `OnConnectionStatus` broadcasts to other channels
5. **File upload handling** — `src/media.ts` downloads/saves media from Slack/WhatsApp
6. **Container resource limits** — `--cap-drop=ALL`, `--memory`, `--cpus`, `--pids-limit`
7. **SDK silence watchdog** — heartbeat logging, 10-min abort, `stream.end()` fix
8. **Error notifications** — sends failure message to user on agent error

### Bug Fixes (5)

1. Task scheduler duplicate run prevention (pre-advance `next_run`)
2. Orphaned `once` task cleanup on startup
3. `list_tasks` stale snapshot in IPC (reads pending task files)
4. SDK for-await hang (`stream.end()` after result)
5. QR code shell escaping in whatsapp-auth (upstream fixed differently)

### Security Hardening (3)

1. Container capability dropping (`--cap-drop=ALL`, configurable)
2. IPC file size limit (1MB, oversized moved to errors dir)
3. IPC message truncation (50k char cap)

### Personal Config

- `skills_for_nanoclaw/` — security-check, trip-map, and other skills
- `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md` — integration docs, behavioral instructions
- `groups/slack-main/` — Slack group folder
- `docs/GMAIL-SETUP.md`, `docs/INTEGRATIONS.md`, trip-map specs

## Phases

### Phase 1: Foundation

**Goal:** Reset to upstream, get Slack working with the new channel registry.

1. Create `pre-update-backup` branch from current `main`
2. Stop launchd service (`launchctl unload`)
3. Reset main to upstream (`git reset --hard origin/main`)
4. Re-add Slack dependencies (`@slack/bolt`, `dotenv`) to `package.json`
5. Port `src/channels/slack.ts` — adapt to channel registry pattern
6. Register Slack in startup flow
7. Verify WhatsApp stays non-blocking (Slack can start independently)
8. `npm run build`, start service, confirm Slack DM gets a response

**Deliverable:** NanoClaw on upstream code, Slack working, no MCP integrations.
**Rollback:** `git checkout pre-update-backup`

### Phase 2: Core Features

**Goal:** Re-apply features that make the system usable day-to-day.

1. **Progress streaming** — port to agent-runner + host + Slack threads
2. **SDK silence watchdog** — heartbeat, hard timeout, `stream.end()` fix
3. **Error notifications** — failure message to user
4. **File upload handling** — restore `src/media.ts`, `src/transcription.ts`, wire into Slack
5. **Skill model override** — port `detectSkillModel()` and `skills_for_nanoclaw/` sync
6. **Weekly session rotation** — port DB schema, `rotateSession()`, Sunday timer
7. **Cross-channel health notifications** — port `OnConnectionStatus` and broadcast logic
8. `npm run build && ./container/build.sh`, test progress streaming via Slack

**Deliverable:** Full-featured Slack experience, no MCP integrations.

### Phase 3: OneCLI + Integrations

**Goal:** Set up OneCLI, re-add all MCP integrations.

1. Run `/init-onecli` to install vault and migrate `.env` credentials
2. Restore `container/mcp-servers/foursquare/`, `container/mcp-servers/gmail/`, `container/bin/slack-mcp-server` from backup branch
3. Update Dockerfile with build steps and pinned MCP package versions
4. Update agent-runner MCP config — all 12 integrations using OneCLI patterns
5. Update container-runner volume mounts (Gmail/Calendar/Drive/host logs)
6. Re-add container resource limits (`--cap-drop=ALL`, memory/CPU/PID)
7. `./container/build.sh`
8. Smoke test: Todoist, Gmail, Calendar, Foursquare, Open Brain

**Deliverable:** All integrations working with OneCLI secret management.

### Phase 4: Polish

**Goal:** Bug fixes, security, personal config, full verification.

1. Port bug fixes (check upstream overlap first):
   - Task scheduler duplicate run prevention
   - Orphaned `once` task cleanup
   - `list_tasks` stale snapshot fix
   - SDK for-await hang fix
2. Re-add IPC security (1MB file limit, 50k char truncation) — check upstream overlap
3. Restore personal config from backup:
   - `groups/main/CLAUDE.md`, `groups/global/CLAUDE.md` (adapt to new architecture)
   - `docs/GMAIL-SETUP.md`, `docs/INTEGRATIONS.md`, trip-map specs
4. Update project `CLAUDE.md` for new architecture
5. End-to-end test via Slack:
   - Normal message, scheduled task, progress streaming, voice transcription, file upload, MCP tools
6. Clean up: clear agent-runner cache, verify launchd service
7. Update memory files to reflect new architecture

**Deliverable:** Fully updated, tested system. `pre-update-backup` retained for rollback.
