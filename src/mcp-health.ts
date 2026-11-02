import { logger } from './logger.js';

/**
 * MCP server health, as reported by the SDK's init message inside each
 * container.
 *
 * A stdio MCP server that crashes on startup fails silently: the SDK drops it,
 * the agent simply never sees its tools, and nothing reached the host log. That
 * hid joplin-mcp-server dying on an EACCES at every spawn for months. The
 * agent-runner now forwards each server's status between its own marker pair
 * (separate from the output markers, so the legacy last-output parse and the
 * onOutput consumers never see it).
 *
 * Every failure is logged. Slack is notified once per server when it starts
 * failing and once when it reconnects, so a persistently broken server does not
 * warn on every message. State is in-memory and resets on restart.
 */

export const MCP_STATUS_START_MARKER = '---NANOCLAW_MCP_STATUS_START---';
export const MCP_STATUS_END_MARKER = '---NANOCLAW_MCP_STATUS_END---';

export interface McpServerReport {
  name: string;
  status: string;
}

// 'pending' at init means still connecting, not broken — logged, not alerted.
const FAILURE_STATUSES = new Set(['failed', 'needs-auth']);

type NotifyFn = (text: string) => void | boolean | Promise<void | boolean>;

let notify: NotifyFn = () => {
  // Default no-op until index.ts wires the real channel at startup.
};

// server name → the failure status it was last alerted for
const failing = new Map<string, string>();

export function setMcpHealthNotify(fn: NotifyFn): void {
  notify = fn;
}

function safeNotify(text: string): void {
  try {
    const result = notify(text);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((err) => {
        logger.error({ err }, 'mcp-health notify rejected');
      });
    }
  } catch (err) {
    logger.error({ err }, 'mcp-health notify threw');
  }
}

export function recordMcpStatus(
  group: string,
  servers: McpServerReport[],
): void {
  for (const { name, status } of servers) {
    if (FAILURE_STATUSES.has(status)) {
      logger.error(
        { group, server: name, status },
        'MCP server failed to start — its tools are unavailable to the agent',
      );
      if (!failing.has(name)) {
        failing.set(name, status);
        safeNotify(
          `⚠ MCP server "${name}" ${status === 'needs-auth' ? 'needs auth' : 'failed to start'} ` +
            `(group ${group}). Its tools are unavailable to the agent. ` +
            'Run the server by hand in the agent image to see why.',
        );
      }
    } else if (status === 'connected') {
      if (failing.delete(name)) {
        logger.info({ group, server: name }, 'MCP server recovered');
        safeNotify(`✓ MCP server "${name}" recovered.`);
      }
    } else {
      logger.warn(
        { group, server: name, status },
        'MCP server not connected at session init',
      );
    }
  }
}

/**
 * Pull complete MCP status marker pairs out of a stdout buffer. Returns the
 * parsed reports and the unconsumed remainder to carry into the next chunk.
 */
export function extractMcpStatusReports(buffer: string): {
  reports: McpServerReport[][];
  rest: string;
} {
  const reports: McpServerReport[][] = [];
  let rest = buffer;
  let startIdx: number;
  while ((startIdx = rest.indexOf(MCP_STATUS_START_MARKER)) !== -1) {
    const endIdx = rest.indexOf(MCP_STATUS_END_MARKER, startIdx);
    if (endIdx === -1) {
      return { reports, rest: rest.slice(startIdx) };
    }
    const json = rest
      .slice(startIdx + MCP_STATUS_START_MARKER.length, endIdx)
      .trim();
    rest = rest.slice(endIdx + MCP_STATUS_END_MARKER.length);
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) reports.push(parsed);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse MCP status report');
    }
  }
  // No marker in flight. Keep only a tail that could be the start of a marker
  // split across chunks, so the buffer cannot grow without bound.
  return { reports, rest: rest.slice(-(MCP_STATUS_START_MARKER.length - 1)) };
}

/** @internal */
export function _resetForTests(): void {
  failing.clear();
  notify = () => {};
}
