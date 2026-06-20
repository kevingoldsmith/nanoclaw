import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  CONTAINER_MEMORY_LIMIT: '2g',
  CONTAINER_CPU_LIMIT: '2',
  CONTAINER_CAP_DROP: true,
  ONECLI_URL: 'http://localhost:10254',
  DATA_DIR: '/tmp/nanoclaw-test-data',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock @onecli-sh/sdk
vi.mock('@onecli-sh/sdk', () => {
  class OneCLI {
    applyContainerConfig = vi.fn(async () => true);
    ensureAgent = vi.fn(async () => ({ created: false }));
    constructor(_opts: unknown) {}
  }
  return { OneCLI };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock container-runtime
vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: () => [],
  readonlyMountArgs: (h: string, c: string) => ['-v', `${h}:${c}:ro`],
  stopContainer: vi.fn(),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput, applyAuthStateDetection, AUTH_BROKEN_FRIENDLY } from './container-runner.js';
import { _resetForTests as _resetAuthState, getAuthState } from './auth-state.js';
import type { RegisteredGroup } from './types.js';

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner: applyAuthStateDetection', () => {
  beforeEach(() => {
    _resetAuthState();
  });

  it('passes through non-success outputs unchanged', () => {
    const errorOutput = {
      status: 'error' as const,
      result: 'Failed to authenticate. API Error: 401',
      error: 'something',
    };
    expect(applyAuthStateDetection(errorOutput)).toBe(errorOutput);
    expect(getAuthState()).toBe('healthy');

    const progressOutput = {
      status: 'progress' as const,
      result: 'Failed to authenticate. API Error: 401',
    };
    expect(applyAuthStateDetection(progressOutput)).toBe(progressOutput);
  });

  it('passes through success outputs with null result unchanged', () => {
    const out = { status: 'success' as const, result: null };
    expect(applyAuthStateDetection(out)).toBe(out);
    expect(getAuthState()).toBe('healthy');
  });

  it('detects the bare SDK 401 message and rewrites to friendly text', () => {
    const out = {
      status: 'success' as const,
      result: 'Failed to authenticate. API Error: 401 terminated',
    };
    const result = applyAuthStateDetection(out);
    expect(result.result).toBe(AUTH_BROKEN_FRIENDLY);
    expect(getAuthState()).toBe('broken');
  });

  it('detects the JSON-shaped authentication_error payload and rewrites', () => {
    const out = {
      status: 'success' as const,
      result:
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_abc"}',
    };
    const result = applyAuthStateDetection(out);
    expect(result.result).toBe(AUTH_BROKEN_FRIENDLY);
    expect(getAuthState()).toBe('broken');
  });

  it('does NOT false-positive on user prose about authentication_error', () => {
    const out = {
      status: 'success' as const,
      result:
        'You may see an authentication_error in the logs when an Invalid authentication credentials situation occurs.',
    };
    const result = applyAuthStateDetection(out);
    expect(result.result).toBe(out.result); // unchanged
    expect(getAuthState()).toBe('healthy');
  });

  it('marks healthy on a successful non-401 result', () => {
    // Set up broken state first so the transition can fire
    const broken = {
      status: 'success' as const,
      result: 'Failed to authenticate. API Error: 401',
    };
    applyAuthStateDetection(broken);
    expect(getAuthState()).toBe('broken');

    const ok = {
      status: 'success' as const,
      result: 'Here is your answer about the weather.',
    };
    const result = applyAuthStateDetection(ok);
    expect(result).toBe(ok);
    expect(getAuthState()).toBe('healthy');
  });
});
