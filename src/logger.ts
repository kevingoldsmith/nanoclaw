import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createStream, type RotatingFileStream } from 'rotating-file-stream';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

// LOG_DIR enables a rotated file at <LOG_DIR>/nanoclaw.log alongside
// console output. Defaults to ~/Library/Logs/nanoclaw on macOS; set
// LOG_DIR="" to disable file logging (e.g. on Linux/systemd where
// journald captures stdout).
const LOG_DIR =
  process.env.LOG_DIR ??
  (process.platform === 'darwin' && process.env.HOME
    ? join(process.env.HOME, 'Library/Logs/nanoclaw')
    : '');

let fileStream: RotatingFileStream | null = null;

if (LOG_DIR) {
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    fileStream = createStream('nanoclaw.log', {
      path: LOG_DIR,
      size: '10M',
      interval: '1d',
      maxFiles: 14,
      compress: 'gzip',
    });
    fileStream.on('error', (err) => {
      process.stderr.write(
        `[logger] rotating-file-stream error: ${(err as Error).message}\n`,
      );
    });
  } catch (e) {
    process.stderr.write(
      `[logger] failed to open rotating file: ${(e as Error).message}\n`,
    );
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{\n      "type": "${err.constructor.name}",\n      "message": "${err.message}",\n      "stack":\n          ${err.stack}\n    }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`;
    } else {
      out += `\n    ${KEY_COLOR}${k}${RESET}: ${JSON.stringify(v)}`;
    }
  }
  return out;
}

function ts(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const consoleStream =
    LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const time = ts();

  let consoleLine: string;
  if (typeof dataOrMsg === 'string') {
    consoleLine = `[${time}] ${tag} (${process.pid}): ${MSG_COLOR}${dataOrMsg}${RESET}\n`;
  } else {
    consoleLine = `[${time}] ${tag} (${process.pid}): ${MSG_COLOR}${msg ?? ''}${RESET}${formatData(dataOrMsg)}\n`;
  }

  consoleStream.write(consoleLine);
  if (fileStream) {
    fileStream.write(consoleLine.replace(ANSI_RE, ''));
  }
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
