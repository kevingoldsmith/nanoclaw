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
