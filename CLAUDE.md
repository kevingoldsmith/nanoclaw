# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/channels/slack.ts` | Slack channel (Socket Mode DMs and mentions) |
| `src/credential-proxy.ts` | HTTP proxy that injects API credentials into container requests |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/media.ts` | File upload handling (download, save, size limit) |
| `src/transcription.ts` | Audio transcription via OpenAI Whisper |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `container/mcp-servers/foursquare/` | Foursquare/Swarm check-in MCP server (local) |
| `container/mcp-servers/gmail/` | Gmail MCP server (local fork, auto-persists refreshed tokens) |
| `skills_for_nanoclaw/` | User skills synced into containers on each spawn (source of truth) |

## Secrets / Credentials

Two auth modes for the Anthropic API, configured via `.env`:

- **API key mode** (`ANTHROPIC_API_KEY` set): Uses the credential proxy (`src/credential-proxy.ts`) on port 3001. Containers get `ANTHROPIC_BASE_URL` pointing to the proxy and a placeholder key; the proxy substitutes the real key at the transport layer.
- **OAuth mode** (`CLAUDE_CODE_OAUTH_TOKEN` set, no API key): Token is passed directly to containers. The SDK handles OAuth auth internally (token exchange, refresh). The agent-runner's `createSanitizeBashHook` strips the token from Bash subprocesses. OAuth tokens are refreshed by Claude Code and stored in the macOS Keychain (`security find-generic-password -s "Claude Code-credentials" -w`). If the token in `.env` becomes stale, pull the fresh one from Keychain.

MCP integration secrets (Todoist, Foursquare, Joplin, etc.) are passed as container env vars, read from `.env` by the container runner.

## MCP Server Selection

When adding a new MCP integration, always check for an **official MCP server** published by the service provider before considering third-party packages. Official servers are maintained by the team that owns the API, so they stay current when API versions change. Search the provider's GitHub org and documentation first (e.g. `@doist/todoist-ai` for Todoist, not a community wrapper). Only use third-party packages when no official server exists.

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/init-onecli` | Install OneCLI Agent Vault and migrate `.env` credentials to it |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Skill Model Override

Skills in `skills_for_nanoclaw/` can specify `model: claude-opus-4-6` (or any model string) in their SKILL.md frontmatter. The agent-runner detects skill references in the prompt, reads the frontmatter, and passes the model to the SDK `query()` call.

## Progress Streaming

Agent text messages are streamed back to the user as progress updates during long-running skills. Short text (20-500 chars) is emitted as `progress` status; longer text (500+ chars) is tracked as fallback for the final result. On Slack, progress messages go into a thread.

## Agent-Runner Source Cache

The agent-runner TypeScript source is cached per-group at `data/sessions/{group}/agent-runner-src/` and only copied on first run. After editing `container/agent-runner/src/`, you **must** clear the cache for changes to take effect:

```bash
rm -rf data/sessions/*/agent-runner-src
```

## Container Security

Containers run with hardened defaults. Configure via `.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CONTAINER_CAP_DROP` | `true` | Drop all Linux capabilities (`--cap-drop=ALL`) |
| `CONTAINER_MEMORY_LIMIT` | `2g` | Container memory limit |
| `CONTAINER_CPU_LIMIT` | `2` | Container CPU limit |

IPC files from containers are limited to 1MB. Oversized files are moved to `data/ipc/errors/` for inspection. Outbound IPC messages are truncated at 50,000 characters.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
