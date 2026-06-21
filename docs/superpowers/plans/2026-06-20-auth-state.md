# Anthropic OAuth Auth-State Tracking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a host-side state machine that detects 401 failures from container runs, suppresses repeated notifications, skips scheduled tasks while auth is broken, and signals recovery on the next successful run.

**Architecture:** A new `src/auth-state.ts` module holds in-memory state (`'healthy' | 'broken'`) and a notify callback. `src/container-runner.ts` calls `markBroken()` / `markHealthy()` based on the container's result text and rewrites raw 401 output to a friendly message. `src/task-scheduler.ts` skips ticks when state is broken. `src/index.ts` wires the notify callback at startup.

**Tech Stack:** TypeScript, vitest. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-06-20-auth-state-design.md`](../specs/2026-06-20-auth-state-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/auth-state.ts` | State machine + notify wiring (new) |
| `src/auth-state.test.ts` | State transition tests (new) |
| `src/container-runner.ts` | 401 detection + result rewrite + state transitions |
| `src/container-runner.test.ts` | New tests for `applyAuthStateDetection` (regex matching, state transitions, false-positive guards) |
| `src/task-scheduler.ts` | Skip due tasks when state is broken |
| `src/task-scheduler.test.ts` | Skip-when-broken test |
| `src/index.ts` | Wire setNotify at startup |
| `CLAUDE.md` | Document the behavior |

---

### Task 1: Auth-state module skeleton + state machine

**Files:**
- Create: `src/auth-state.ts`
- Create: `src/auth-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/auth-state.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests,
  getAuthState,
  markBroken,
  markHealthy,
  setNotify,
} from './auth-state.js';

describe('auth-state', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('starts in healthy state', () => {
    expect(getAuthState()).toBe('healthy');
  });

  it('markBroken transitions healthy → broken and notifies once', () => {
    const notify = vi.fn();
    setNotify(notify);

    markBroken('test reason');

    expect(getAuthState()).toBe('broken');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Anthropic auth failed.*test reason.*\/login/i),
    );
  });

  it('markBroken is a no-op when already broken (no second notify)', () => {
    const notify = vi.fn();
    setNotify(notify);

    markBroken('first');
    markBroken('second');

    expect(getAuthState()).toBe('broken');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('markHealthy transitions broken → healthy and notifies once', () => {
    const notify = vi.fn();
    setNotify(notify);

    markBroken('downstream');
    notify.mockClear();

    markHealthy();

    expect(getAuthState()).toBe('healthy');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Anthropic auth recovered/i),
    );
  });

  it('markHealthy is a no-op when already healthy', () => {
    const notify = vi.fn();
    setNotify(notify);

    markHealthy();

    expect(getAuthState()).toBe('healthy');
    expect(notify).not.toHaveBeenCalled();
  });

  it('notify errors do not block state transition', () => {
    const notify = vi.fn(() => {
      throw new Error('slack down');
    });
    setNotify(notify);

    expect(() => markBroken('reason')).not.toThrow();
    expect(getAuthState()).toBe('broken');
  });

  it('works without a notify set (silent transition)', () => {
    // Don't call setNotify; default is no-op
    expect(() => markBroken('reason')).not.toThrow();
    expect(getAuthState()).toBe('broken');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- auth-state`
Expected: FAIL with module not found / functions not exported.

- [ ] **Step 3: Implement the state machine**

Create `src/auth-state.ts`:

```ts
import { logger } from './logger.js';

export type AuthState = 'healthy' | 'broken';

type NotifyFn = (text: string) => void | Promise<void>;

let state: AuthState = 'healthy';
let notify: NotifyFn = () => {
  // Default no-op until index.ts wires the real callback at startup.
};

export function getAuthState(): AuthState {
  return state;
}

export function setNotify(fn: NotifyFn): void {
  notify = fn;
}

function safeNotify(text: string): void {
  try {
    const result = notify(text);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((err) => {
        logger.error({ err }, 'auth-state notify rejected');
      });
    }
  } catch (err) {
    logger.error({ err }, 'auth-state notify threw');
  }
}

export function markBroken(reason: string): void {
  if (state === 'broken') return;
  state = 'broken';
  logger.warn({ reason }, 'auth-state: broken');
  safeNotify(
    `⚠ Anthropic auth failed (${reason}). Run /login on the Mac Mini.`,
  );
}

export function markHealthy(): void {
  if (state === 'healthy') return;
  state = 'healthy';
  logger.info('auth-state: recovered');
  safeNotify('✓ Anthropic auth recovered.');
}

/** @internal - test only */
export function _resetForTests(): void {
  state = 'healthy';
  notify = () => {};
}
```

- [ ] **Step 4: Run test to verify they pass**

Run: `npm test -- auth-state`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/auth-state.ts src/auth-state.test.ts
git commit -m "feat: auth-state state machine with notify-once transitions"
```

---

### Task 2: Detect 401 in container output and rewrite

**Files:**
- Modify: `src/container-runner.ts`

This task plugs the detection into the existing `runContainerAgent` function. The container's final result text is assembled in the `resolve(...)` block at the end of the Promise. We need to:

1. After the result text is computed, run it through a detector.
2. If it matches the 401 pattern, call `markBroken('401 from Anthropic API')` and replace the text with the friendly message.
3. Otherwise (any successful non-error result), call `markHealthy()`.

- [ ] **Step 1: Locate the result-resolution point**

Open `src/container-runner.ts`. The `runContainerAgent` function returns a Promise that resolves with a `ContainerOutput` once the container exits. Find the `container.on('close', ...)` or equivalent block near the end of the function (look for the `resolve(` call that returns the final `ContainerOutput`).

If multiple `resolve` calls exist (error paths, timeout paths, success), you only need to add detection to the **success path** where actual agent output was received. Error paths (timeout, container crash) don't need the rewrite — they're already distinct from 401s.

- [ ] **Step 2: Add the import**

At the top of `src/container-runner.ts`, with the other local imports:

```ts
import { markBroken, markHealthy } from './auth-state.js';
```

- [ ] **Step 3: Add a detection helper near the top of the file**

Just below the existing constants (around the `OUTPUT_START_MARKER` definitions):

```ts
const AUTH_401_PATTERN =
  /Failed to authenticate\. API Error: 401|authentication_error.*Invalid authentication credentials/;
const AUTH_BROKEN_FRIENDLY =
  '⚠ Anthropic auth is broken. Run /login on the Mac Mini.';

function detectAndHandleAuthState(text: string | null): string | null {
  if (text === null) return text;
  if (AUTH_401_PATTERN.test(text)) {
    markBroken('401 from Anthropic API');
    return AUTH_BROKEN_FRIENDLY;
  }
  // Non-empty success result that doesn't match 401 → confirms auth works.
  if (text.length > 0) {
    markHealthy();
  }
  return text;
}
```

- [ ] **Step 4: Apply the detector to the resolve path**

In the `runContainerAgent` Promise body, find where the final `ContainerOutput` is built before being passed to `resolve(...)`. The output has a `text` field (the agent's reply). Wrap that field through `detectAndHandleAuthState`:

For example, if the existing code looks like:
```ts
resolve({
  text: agentResultText,
  newSessionId,
  error,
  // ...
});
```

Change to:
```ts
resolve({
  text: detectAndHandleAuthState(agentResultText),
  newSessionId,
  error,
  // ...
});
```

If the result-building code is more complex (assembled across multiple branches), put the detector call in one consolidated place — ideally just before `resolve`.

> **Engineer note:** The exact shape of the resolve block depends on the current `runContainerAgent` body. Read the function end-to-end before editing. The intent is: every result that has a `text` field representing the agent's reply must pass through `detectAndHandleAuthState`. Apply minimum diff; do not refactor the surrounding code.

- [ ] **Step 5: Typecheck and run all tests**

Run: `npm run typecheck && npm test`
Expected: typecheck clean, all existing tests pass, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: detect 401 in container output, rewrite to friendly message"
```

---

### Task 3: Scheduler skips when auth is broken

**Files:**
- Modify: `src/task-scheduler.ts`
- Modify: `src/task-scheduler.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/task-scheduler.test.ts`:

```ts
import { _resetForTests as _resetAuthState, markBroken } from './auth-state.js';

describe('task scheduler: skips when auth is broken', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    _resetAuthState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not enqueue due tasks when auth state is broken', async () => {
    createTask({
      id: 'task-auth-broken',
      group_folder: 'main',
      chat_jid: 'main@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-06-20T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-06-20T00:00:00.000Z',
    });

    markBroken('test'); // skip notify wiring; default no-op

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(enqueueTask).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- task-scheduler`
Expected: the new test FAILS (because the scheduler currently doesn't check auth state, so it would still enqueue).

- [ ] **Step 3: Add the skip in `src/task-scheduler.ts`**

In `startSchedulerLoop`, at the top of the inner `loop` function (just inside the `try` block, before `getDueTasks()` is called), add:

```ts
import { getAuthState } from './auth-state.js';
```
(at the top of the file with other imports)

And in the loop:

```ts
const loop = async () => {
  try {
    if (getAuthState() === 'broken') {
      logger.warn(
        'Skipping scheduled tasks tick: Anthropic auth is broken',
      );
      setTimeout(loop, SCHEDULER_POLL_INTERVAL);
      return;
    }

    const dueTasks = getDueTasks();
    // ... rest unchanged
  } catch (err) {
    // ... unchanged
  }
  setTimeout(loop, SCHEDULER_POLL_INTERVAL);
};
```

> **Engineer note:** Be careful with the `setTimeout(loop, ...)` placement — the existing function has it OUTSIDE the try/catch at the bottom of the loop. Adding an early `return` inside the try means the bottom-of-loop setTimeout won't fire, so the skip branch needs its own `setTimeout(loop, ...)` before returning (as shown above). Don't double-schedule.

- [ ] **Step 4: Run tests**

Run: `npm test -- task-scheduler`
Expected: the new test passes; existing scheduler tests continue to pass.

- [ ] **Step 5: Commit**

```bash
git add src/task-scheduler.ts src/task-scheduler.test.ts
git commit -m "feat: scheduler skips ticks when Anthropic auth is broken"
```

---

### Task 4: Wire notify callback in src/index.ts

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add the import**

At the top of `src/index.ts`, alongside the credential-drop-watcher import:

```ts
import { setNotify as setAuthStateNotify } from './auth-state.js';
```

- [ ] **Step 2: Wire setNotify after channels connect**

Find the block where `startCredentialDropWatcher({...})` is called (in `src/index.ts`, after `startSchedulerLoop`). Add a `setAuthStateNotify(...)` call **before** `startCredentialDropWatcher` (so the auth-state notify is wired before any tasks or messages could fire):

```ts
setAuthStateNotify(async (text: string) => {
  for (const [jid] of Object.entries(registeredGroups)) {
    for (const ch of channels) {
      if (ch.isConnected() && ch.ownsJid(jid)) {
        try {
          await ch.sendMessage(jid, text);
        } catch (err) {
          logger.error(
            { err, channel: ch.name },
            'auth-state: failed to send notification',
          );
        }
        return;
      }
    }
  }
  logger.warn(
    { text },
    'auth-state: no connected channel for notification',
  );
});
```

This is the same shape as the credential-drop-watcher's notify wiring — extracting a helper isn't worth it for two callers.

- [ ] **Step 3: Typecheck, build, run all tests**

Run: `npm run typecheck && npm run build && npm test`
Expected: all clean, all tests passing.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire auth-state notify callback at startup"
```

---

### Task 5: Document in CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a section to CLAUDE.md**

After the "Credential Drop Watcher" section (added in the previous feature), add:

```markdown
## Anthropic Auth-State Tracking

nanoclaw tracks the health of its Anthropic OAuth credentials with an in-memory state machine (`src/auth-state.ts`). On every container run, the result is inspected for the 401 `Failed to authenticate` marker:

- **401 detected:** state transitions to `broken`. A single Slack DM is sent (`⚠ Anthropic auth failed (...). Run /login on the Mac Mini.`). Scheduled tasks are skipped while broken — no cron-driven 401 spam.
- **Successful non-401 result:** state transitions to `healthy`. A single Slack DM is sent (`✓ Anthropic auth recovered.`).
- **Repeated 401s while broken:** the raw 401 text is rewritten to a friendly user-facing message; no extra Slack notifications fire.
- **nanoclaw restart:** state resets to `healthy` — the next container spawn re-establishes ground truth.

The `.env` `CLAUDE_CODE_OAUTH_TOKEN` is still used as a warm-start fallback when Keychain refresh fails. To recover from a broken state, `/login` on the Mac Mini and the next message should succeed; the recovery notification confirms the fix.
```

- [ ] **Step 2: Update the Key Files table**

Add to the table (alphabetical position):

```markdown
| `src/auth-state.ts` | In-memory Anthropic auth health tracker; broken/healthy transitions, notify-once |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: auth-state tracking in CLAUDE.md"
```

---

## Self-Review

**Spec coverage:**
- New module → Task 1 ✓
- 401 detection + rewrite → Task 2 ✓
- Scheduler skip → Task 3 ✓
- Notify wiring → Task 4 ✓
- Docs → Task 5 ✓
- Inbound-message behavior is structural-no-change as designed (Task 2's rewrite handles it).

**Placeholder scan:** Task 2 contains one "find the resolve block" hedge because `runContainerAgent` is large and its result-resolution structure isn't fully visible in the plan; the engineer reads the function and applies the detector at the consolidated resolve point. The intent is concrete (apply `detectAndHandleAuthState` to the `text` field before `resolve`), only the line number is engineer-determined.

**Type consistency:** `AuthState`, `NotifyFn`, `markBroken`, `markHealthy`, `getAuthState`, `setNotify`, `_resetForTests` are introduced in Task 1 and reused consistently across Tasks 2-4.

**Scope check:** Five small tasks, all on local files, no new dependencies. Right size for a single implementation pass.
