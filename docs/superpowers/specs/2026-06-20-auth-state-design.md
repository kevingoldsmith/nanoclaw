# Anthropic OAuth Auth-State Tracking Design

**Date:** 2026-06-20
**Status:** Approved
**Approach:** In-memory host-side state machine with notify-once transitions, post-spawn 401 detection, and scheduler-skip-on-broken.

## Context

nanoclaw's `src/container-runner.ts` already auto-refreshes the Anthropic OAuth token from macOS Keychain on every container spawn ([[container-runner.ts:188-200]]). When refresh works (the common case), the system is self-sustaining indefinitely as long as the Keychain refresh token stays valid.

But the refresh path has failure modes — transient network issues, rate limits, endpoint hiccups, or server-side revocation. When it fails, nanoclaw silently falls back to the `.env` `CLAUDE_CODE_OAUTH_TOKEN` value, which is typically days or weeks old by then. The container runs with that stale token, the Anthropic API rejects it with a 401, and the raw 401 text is sent back to the user as the agent's reply.

Symptoms observed on 2026-06-20:
- Slack DM: `Failed to authenticate. API Error: 401 {"type":"error",...}`
- Same 401 fired for **every** subsequent Slack message and **every** scheduled task tick, until the user manually intervened.
- No notification of when auth recovered after `/login` + restart.

This becomes critical for the user's upcoming 30-day trip. The Mac Mini cannot accept inbound connections (per the credential-drop watcher decision), so remote `/login` isn't possible. The user needs:

1. **Clear, single signal** when auth breaks ("⚠ broken, run /login").
2. **Clear, single signal** when auth recovers ("✓ recovered").
3. **No spam** during the broken window — neither cron-driven tasks nor repeated user retries should emit 401s.
4. **Friendly response** to incoming user messages while broken, instead of the raw 401 text.

## Decisions

- **In-memory state only.** Reset on nanoclaw restart. Startup naturally re-tries Keychain on the first container spawn, so persistence buys nothing.
- **Keep `.env` fallback.** It's a useful warm-start cushion right after a fresh `/login`; the symptom we're fixing is silent persistent failure, not the fallback itself.
- **No background probe.** Recovery is detected on the next non-401 result from a real container spawn — natural retry path.
- **Post-spawn detection of 401**, not pre-spawn validation. The only authoritative auth check is an actual Anthropic API request; cheap heuristic checks (token presence, etc.) don't tell us what the server will accept.
- **Notify-once on transitions.** The state machine has exactly two states (`healthy` / `broken`); messages fire only on transitions, never on steady-state.

## Architecture

```
                       ┌──────────────────────────┐
                       │  src/auth-state.ts       │
                       │                          │
  container-runner ───►│  markBroken(reason)      │──► notify Slack (once)
                       │  markHealthy()           │
                       │  getAuthState()          │
                       │                          │
  task-scheduler   ◄───│       ▲                  │
   (skip when           │       │ injected at startup
    broken)             └───────┼──────────────────┘
                                │
                                │ notify(text) callback
                                │   findChannel(jid) → ch.sendMessage(jid, text)
                                │
                          src/index.ts
                          (wires the callback)
```

## Components

### New module: `src/auth-state.ts`

Exports:
- `type AuthState = 'healthy' | 'broken'`
- `getAuthState(): AuthState`
- `markBroken(reason: string): void` — transitions only on `healthy → broken`. Logs and calls notify(`⚠ Anthropic auth failed (...). Run /login on the Mac Mini.`). No-op if already broken.
- `markHealthy(): void` — transitions only on `broken → healthy`. Logs and calls notify(`✓ Anthropic auth recovered.`). No-op if already healthy.
- `setNotifyForTests(fn): void` — test seam, called at startup with the real notify.
- `_resetForTests(): void`

Internal state: a module-level `state: AuthState = 'healthy'` and a `notify` callback. Default state on cold start is `healthy` — we don't know yet, and the first failed spawn will transition us.

### Detection in `src/container-runner.ts`

Add a post-spawn inspection of the container result (the existing `runContainerAgent` function builds a `ContainerOutput` with `text`, `error`, etc.).

- If the **agent result text** matches `/Failed to authenticate\. API Error: 401/`:
  - Call `markBroken(<reason>)` where `<reason>` is a short summary (e.g., "401 from Anthropic API").
  - **Rewrite** the result text to `⚠ Anthropic auth is broken. Run /login on the Mac Mini.` so the user sees the friendly version, not the raw 401 JSON.
- If the result is **non-401 success** (`status === 'success'` and no auth-error marker): call `markHealthy()`.

Detection lives in `runContainerAgent` because that's where the result is parsed. No new public API surface — call sites of `runContainerAgent` continue to receive `ContainerOutput` and consume `.text` as before.

### Scheduler skip in `src/task-scheduler.ts`

At the top of the per-tick loop (after `getDueTasks()` but before enqueue/spawn), check `getAuthState()`. If `'broken'`, log once per tick at warn level and `return` — don't spawn anything, don't mark tasks as run, don't reset their `next_run`. Tasks will become due again on the next tick and we'll re-check.

This is the change that stops the cron spam.

### Wiring in `src/index.ts`

At startup, after `channels` are connected and `registeredGroups` is loaded, call `setNotify(...)` with a callback that mirrors the credential-drop watcher's notify pattern (`Object.entries(registeredGroups)` → first owning channel → `ch.sendMessage`). Tear down on shutdown isn't needed (in-memory state vanishes with the process).

### Inbound messages

No structural change. User-sent messages still enqueue and try to spawn a container. The behaviors that fall out for free:
- If still broken: container 401s, the detection in `container-runner.ts` rewrites the reply to the friendly message, **state stays broken** (`markBroken` is no-op when already broken), no extra Slack notification.
- If Keychain has recovered: container succeeds, `markHealthy()` fires, user gets a successful reply AND a separate `✓ recovered` message.

User-sent messages are the only path that exercises a container while broken (because the scheduler is skipping), so they're also the recovery probe.

## Failure handling

| Scenario | Behavior |
|---|---|
| Keychain refresh fails, .env token also stale | Container returns 401 → markBroken → friendly reply → scheduler skips → user gets one warning |
| Repeated 401s on multiple messages | markBroken is no-op after first call → no notify spam; each message gets the friendly reply |
| Refresh succeeds again after a network blip | Next container run succeeds → markHealthy → notify recovery once |
| Notify callback throws | Logged at error, state still transitions; we don't want a broken Slack channel to block auth recovery tracking |
| nanoclaw restart while broken | State resets to `healthy`; first message attempts a spawn; if still 401, markBroken fires fresh notification |

The restart-resets-state behavior is intentional: on restart we have no signal yet, so optimistic `healthy` is correct — the next real spawn will tell us the truth.

## Testing

### `src/auth-state.test.ts` (vitest, new file)
- `markBroken` fires notify once and transitions state
- Second `markBroken` is a no-op (no extra notify)
- `markHealthy` fires notify once on broken → healthy
- `markHealthy` while already healthy is a no-op
- `notify` errors don't prevent state transition

### `src/container-runner.test.ts` (extend existing or add cases)
- The 401 detection regex catches the real error text observed in production logs
- The result text is replaced with the friendly message when 401 is detected
- Successful non-401 results trigger `markHealthy`

### `src/task-scheduler.test.ts` (extend existing)
- When auth state is `broken`, due tasks are NOT enqueued for that tick
- When auth state is `healthy`, normal behavior is preserved

### Manual verification
- Drop a deliberately broken token into `.env` and `/login` to mint a fresh Keychain token, then revoke it server-side via [https://claude.ai/settings/connectors] (if possible) — confirms broken signal.
- Easier test: stop nanoclaw, set the `.env` `CLAUDE_CODE_OAUTH_TOKEN` to a known-bad string, also corrupt Keychain temporarily (or fake `expiresAt` to 0 to force refresh), confirm broken signal and friendly Slack reply.
- Restart, send a message, observe `✓ Anthropic auth recovered.`

## Out of scope

- Pro-active background probe to detect breakage before a user message arrives. Could be added later; not needed for trip safety.
- Persisting auth state across restarts. The restart-resets behavior is desired.
- A separate slash command to manually re-probe auth (`/auth-check` or similar). The natural retry on incoming messages serves this role.
- Auto-running `/login` from inside nanoclaw. The Mac Mini is unattended on the trip; this would require credential mounting that defeats the OAuth model.
- Refresh-token expiry monitoring. We don't currently know the refresh token's lifetime; observing it through field experience is the most reliable signal.

## File changes summary

| File | Change |
|---|---|
| `src/auth-state.ts` | New module |
| `src/auth-state.test.ts` | New tests |
| `src/container-runner.ts` | Add 401 detection + result rewrite + markBroken/markHealthy calls |
| `src/container-runner.test.ts` | Extend with detection tests |
| `src/task-scheduler.ts` | Skip due tasks when state is broken |
| `src/task-scheduler.test.ts` | Extend with skip-when-broken test |
| `src/index.ts` | Wire setNotify at startup |
| `CLAUDE.md` | Document the auth-state behavior |
