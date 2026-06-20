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
