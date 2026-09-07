import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const HOME = os.homedir();

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * account3 (DistroKid) Google credentials live on Testing-mode OAuth clients,
 * whose refresh tokens carry a hard 7-day expiry. Refreshing does NOT mint a
 * new refresh token, so the window cannot self-extend — the only way to reset
 * it is a browser re-consent via `scripts/rotate-account3.sh <service>`.
 *
 * The catch this watcher exists for: running the MCP `auth` command with a
 * valid tokens.json still present silently refreshes the *access* token and
 * prints "Authentication successful." without opening a browser. A weekly
 * calendar reminder therefore reports success while the refresh token keeps
 * counting down to death.
 */
export interface CredentialSpec {
  /** Human label used in notifications. */
  label: string;
  /** Argument to `scripts/rotate-account3.sh`. */
  service: string;
  keysPath: string;
  tokensPath: string;
  /** Some servers nest the token payload (calendar uses `normal`). */
  tokenKey?: string;
}

export const CREDENTIALS: CredentialSpec[] = [
  {
    label: 'account3 drive',
    service: 'drive',
    keysPath: path.join(
      HOME,
      '.config',
      'google-drive-mcp-account3',
      'gcp-oauth.keys.json',
    ),
    tokensPath: path.join(
      HOME,
      '.config',
      'google-drive-mcp-account3',
      'tokens.json',
    ),
  },
  {
    label: 'account3 calendar',
    service: 'calendar',
    // Calendar shares drive's OAuth client but keeps its own token file.
    keysPath: path.join(
      HOME,
      '.config',
      'google-drive-mcp-account3',
      'gcp-oauth.keys.json',
    ),
    tokensPath: path.join(
      HOME,
      '.config',
      'google-calendar-mcp-account3',
      'tokens.json',
    ),
    tokenKey: 'normal',
  },
  {
    label: 'account3 gmail',
    service: 'gmail',
    keysPath: path.join(
      HOME,
      '.gmail-mcp-account3',
      '.gmail-mcp',
      'gcp-oauth.keys.json',
    ),
    tokensPath: path.join(
      HOME,
      '.gmail-mcp-account3',
      '.gmail-mcp',
      'credentials.json',
    ),
  },
];

export type CheckStatus =
  /** Refresh works and is comfortably inside the window. */
  | 'ok'
  /** Refresh works but the refresh token dies within the warn threshold. */
  | 'expiring'
  /** Refresh token rejected — the integration is already down. */
  | 'dead'
  /** Token or key file absent/unreadable. */
  | 'missing'
  /** Transient failure (network, 5xx). Never notified on. */
  | 'unknown';

export interface CheckResult {
  label: string;
  service: string;
  status: CheckStatus;
  /** Remaining refresh-token life. Absent when the server reports none. */
  secondsLeft?: number;
  reason?: string;
  /**
   * Which family of credential this is. The two differ in what a failure
   * means and how it is repaired, so the alert wording is not shared.
   */
  kind?: 'google-refresh' | 'anthropic-fallback';
}

export interface ClientCreds {
  clientId: string;
  clientSecret: string;
}

export function readClientCreds(keysPath: string): ClientCreds {
  const raw = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const inner = (raw.installed ?? raw.web ?? raw) as Record<string, unknown>;
  const clientId = inner.client_id;
  const clientSecret = inner.client_secret;
  if (typeof clientId !== 'string' || typeof clientSecret !== 'string') {
    throw new Error('missing client_id/client_secret');
  }
  return { clientId, clientSecret };
}

export function readRefreshToken(
  tokensPath: string,
  tokenKey?: string,
): string {
  const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const payload = (tokenKey ? raw[tokenKey] : raw) as
    | Record<string, unknown>
    | undefined;
  const token = payload?.refresh_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('no refresh_token in token file');
  }
  return token;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Exchanges the refresh token purely to read `refresh_token_expires_in` — the
 * only place Google reports remaining refresh-token life. The minted access
 * token is discarded and no file is written; a refresh neither rotates nor
 * invalidates the stored refresh token.
 */
export async function checkCredential(
  spec: CredentialSpec,
  warnThresholdSeconds: number,
  doFetch: FetchLike,
): Promise<CheckResult> {
  const base = { label: spec.label, service: spec.service };

  let creds: ClientCreds;
  let refreshToken: string;
  try {
    creds = readClientCreds(spec.keysPath);
    refreshToken = readRefreshToken(spec.tokensPath, spec.tokenKey);
  } catch (err) {
    return { ...base, status: 'missing', reason: (err as Error).message };
  }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();

  let res: Awaited<ReturnType<FetchLike>>;
  let text: string;
  try {
    res = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    text = await res.text();
  } catch (err) {
    return { ...base, status: 'unknown', reason: (err as Error).message };
  }

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Fall through — a non-JSON body is only meaningful for the error path.
  }

  if (!res.ok) {
    const code = typeof parsed.error === 'string' ? parsed.error : undefined;
    // invalid_grant is definitive: revoked, expired, or consent withdrawn.
    if (code === 'invalid_grant') {
      return { ...base, status: 'dead', reason: code };
    }
    return {
      ...base,
      status: 'unknown',
      reason: code ?? `HTTP ${res.status}`,
    };
  }

  const expiresIn = parsed.refresh_token_expires_in;
  if (typeof expiresIn !== 'number') {
    // Gmail's client has not been observed reporting this. Refresh works, so
    // the credential is usable; we simply have no countdown to warn on.
    return { ...base, status: 'ok' };
  }

  return {
    ...base,
    status: expiresIn <= warnThresholdSeconds ? 'expiring' : 'ok',
    secondsLeft: expiresIn,
  };
}

/**
 * nanoclaw's Anthropic auth has two sources. `container-runner` prefers the
 * macOS Keychain token (which Claude Code rotates and this process refreshes),
 * and falls back to `CLAUDE_CODE_OAUTH_TOKEN` from `.env` only when the
 * Keychain read or refresh fails.
 *
 * That fallback is hand-copied, so it cannot track a token that rotates every
 * few hours — it silently rots. Nothing surfaces the rot, because the healthy
 * path never touches it. The failure therefore only ever appears at the worst
 * possible moment: a Keychain hiccup falls through to a revoked token, every
 * container 401s, and scheduled tasks stop.
 *
 * This check exercises the fallback on the same cadence as the account3
 * credentials so it is known-good *before* it is needed. `GET /v1/models` is
 * used deliberately: it authenticates the token without consuming inference.
 */
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';

export const ANTHROPIC_FALLBACK_LABEL = 'Anthropic `.env` fallback';

export const SYNC_FALLBACK_COMMAND = '`./scripts/sync-oauth-fallback.sh`';

export async function checkAnthropicFallback(
  env: Record<string, string>,
  doFetch: FetchLike,
): Promise<CheckResult | null> {
  const base = {
    label: ANTHROPIC_FALLBACK_LABEL,
    service: 'anthropic',
    kind: 'anthropic-fallback' as const,
  };

  // API-key mode never consults the OAuth fallback, so it cannot be at fault.
  if (env.ANTHROPIC_API_KEY) return null;

  const token = env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    return { ...base, status: 'missing', reason: 'not set in .env' };
  }

  let res: Awaited<ReturnType<FetchLike>>;
  let text: string;
  try {
    res = await doFetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
    });
    text = await res.text();
  } catch (err) {
    return { ...base, status: 'unknown', reason: (err as Error).message };
  }

  if (res.ok) return { ...base, status: 'ok' };

  // 401/403 is definitive: revoked, expired, or the token was never valid.
  // Everything else (5xx, rate limits, gateway errors) says nothing about
  // the credential and must not raise an alarm.
  if (res.status !== 401 && res.status !== 403) {
    return { ...base, status: 'unknown', reason: `HTTP ${res.status}` };
  }

  let reason = `HTTP ${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    if (parsed.error?.message) reason = parsed.error.message;
  } catch {
    // Non-JSON body — the status code is reason enough.
  }
  return { ...base, status: 'dead', reason };
}

function formatAnthropicFallbackAlert(result: CheckResult): string {
  // Lead with the fact that nothing is broken yet. This alert fires while
  // agents are running fine, and reads as a false alarm otherwise.
  const preamble =
    'Agents are unaffected right now — nanoclaw prefers the Keychain token. ' +
    'But if a Keychain read or refresh ever fails, there is nothing to fall ' +
    'back to: containers would 401 and scheduled tasks would stop.';

  switch (result.status) {
    case 'dead':
      return (
        `⚠ ${ANTHROPIC_FALLBACK_LABEL} token is dead (${result.reason}). ` +
        `${preamble} Run ${SYNC_FALLBACK_COMMAND}`
      );
    case 'missing':
      return (
        `⚠ ${ANTHROPIC_FALLBACK_LABEL} token is ${result.reason}. ` +
        `${preamble} Run ${SYNC_FALLBACK_COMMAND}`
      );
    default:
      return '';
  }
}

function days(seconds: number): string {
  return `${(seconds / 86400).toFixed(1)}d`;
}

export function formatAlert(result: CheckResult): string {
  if (result.kind === 'anthropic-fallback') {
    return formatAnthropicFallbackAlert(result);
  }
  const rotate = `\`./scripts/rotate-account3.sh ${result.service}\``;
  switch (result.status) {
    case 'expiring':
      return (
        `⚠ ${result.label} refresh token expires in ` +
        `${days(result.secondsLeft ?? 0)} — run ${rotate} (the bare \`auth\` ` +
        `command will NOT re-consent while tokens.json exists)`
      );
    case 'dead':
      return (
        `⚠ ${result.label} refresh token is dead (${result.reason}) — ` +
        `integration is down. Run ${rotate}`
      );
    case 'missing':
      return `⚠ ${result.label} credentials unreadable (${result.reason}) — run ${rotate}`;
    default:
      return '';
  }
}

export function formatRecovery(result: CheckResult): string {
  if (result.kind === 'anthropic-fallback') {
    return (
      '✓ Anthropic `.env` fallback token is valid again — the Keychain ' +
      'failover path is armed.'
    );
  }
  const left =
    typeof result.secondsLeft === 'number'
      ? ` (${days(result.secondsLeft)} left)`
      : '';
  return `✓ ${result.label} credentials renewed${left}.`;
}

/**
 * Per-credential last-notified status, so a credential sitting in `expiring`
 * for two days produces one Slack message rather than one per tick.
 */
const lastNotified = new Map<string, CheckStatus>();

export function _resetForTests(): void {
  lastNotified.clear();
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

/**
 * Returning `false` means the message was NOT delivered (e.g. no channel
 * connected yet at boot). The watcher then leaves the credential unarmed so
 * the alert is retried on the next tick instead of being lost — an alert that
 * never reaches Slack must not count as "already warned".
 */
export type NotifyFn = (
  text: string,
) => void | boolean | Promise<void | boolean>;

export interface RunCheckArgs {
  credentials?: CredentialSpec[];
  warnThresholdSeconds: number;
  notify: NotifyFn;
  doFetch?: FetchLike;
  /** Injectable for tests; reads the real `.env` otherwise. */
  readEnv?: () => Record<string, string>;
}

export async function runExpiryCheckOnce(
  args: RunCheckArgs,
): Promise<CheckResult[]> {
  const {
    credentials = CREDENTIALS,
    warnThresholdSeconds,
    notify,
    doFetch = globalThis.fetch as unknown as FetchLike,
    readEnv = () =>
      readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
  } = args;

  const checks: Array<() => Promise<CheckResult | null>> = [
    ...credentials.map(
      (spec) => () => checkCredential(spec, warnThresholdSeconds, doFetch),
    ),
    () => checkAnthropicFallback(readEnv(), doFetch),
  ];

  const results: CheckResult[] = [];
  for (const check of checks) {
    const result = await check();
    // `null` means the check does not apply (e.g. API-key mode). Skip it
    // without disturbing any armed state.
    if (!result) continue;
    results.push(result);

    const previous = lastNotified.get(result.label);

    // Transient failures tell us nothing — leave the previous state armed.
    if (result.status === 'unknown') {
      logger.warn(
        { label: result.label, reason: result.reason },
        'credential-expiry-watcher: check inconclusive',
      );
      continue;
    }

    if (result.status === 'ok') {
      if (previous && previous !== 'ok') {
        if ((await notify(formatRecovery(result))) === false) continue;
      }
      lastNotified.set(result.label, 'ok');
      continue;
    }

    // Re-notify when the problem changes kind (expiring → dead), not on repeat.
    if (previous !== result.status) {
      if ((await notify(formatAlert(result))) === false) continue;
    }
    lastNotified.set(result.label, result.status);
  }

  logger.info(
    {
      results: results.map((r) => ({
        label: r.label,
        status: r.status,
        secondsLeft: r.secondsLeft,
      })),
    },
    'credential-expiry-watcher: check complete',
  );

  return results;
}

export interface StartArgs {
  intervalMs: number;
  warnThresholdSeconds: number;
  notify: NotifyFn;
}

let interval: NodeJS.Timeout | null = null;

export function startCredentialExpiryWatcher(args: StartArgs): void {
  const { intervalMs, warnThresholdSeconds, notify } = args;

  const tick = () => {
    runExpiryCheckOnce({ warnThresholdSeconds, notify }).catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'credential-expiry-watcher: tick failed',
      );
    });
  };

  tick();
  interval = setInterval(tick, intervalMs);

  logger.info(
    { intervalMs, warnThresholdSeconds },
    'credential-expiry-watcher: started',
  );
}

export function stopCredentialExpiryWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
