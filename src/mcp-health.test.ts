import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests,
  extractMcpStatusReports,
  MCP_STATUS_END_MARKER,
  MCP_STATUS_START_MARKER,
  recordMcpStatus,
  setMcpHealthNotify,
} from './mcp-health.js';

const wrap = (servers: unknown) =>
  `${MCP_STATUS_START_MARKER}\n${JSON.stringify(servers)}\n${MCP_STATUS_END_MARKER}\n`;

describe('mcp-health: recordMcpStatus', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('notifies once when a server fails, not on every spawn', () => {
    const notify = vi.fn();
    setMcpHealthNotify(notify);

    recordMcpStatus('main', [{ name: 'joplin', status: 'failed' }]);
    recordMcpStatus('main', [{ name: 'joplin', status: 'failed' }]);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/joplin.*failed to start/),
    );
  });

  it('notifies recovery once when a failed server connects', () => {
    const notify = vi.fn();
    setMcpHealthNotify(notify);

    recordMcpStatus('main', [{ name: 'joplin', status: 'failed' }]);
    recordMcpStatus('main', [{ name: 'joplin', status: 'connected' }]);
    recordMcpStatus('main', [{ name: 'joplin', status: 'connected' }]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(
      expect.stringMatching(/joplin.*recovered/),
    );
  });

  it('re-alerts if a recovered server fails again', () => {
    const notify = vi.fn();
    setMcpHealthNotify(notify);

    recordMcpStatus('main', [{ name: 'joplin', status: 'failed' }]);
    recordMcpStatus('main', [{ name: 'joplin', status: 'connected' }]);
    recordMcpStatus('main', [{ name: 'joplin', status: 'failed' }]);

    expect(notify).toHaveBeenCalledTimes(3);
  });

  it('tracks servers independently', () => {
    const notify = vi.fn();
    setMcpHealthNotify(notify);

    recordMcpStatus('main', [
      { name: 'joplin', status: 'failed' },
      { name: 'todoist', status: 'needs-auth' },
      { name: 'gmail', status: 'connected' },
    ]);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/todoist.*needs auth/),
    );
  });

  it('does not alert for healthy or still-pending servers', () => {
    const notify = vi.fn();
    setMcpHealthNotify(notify);

    recordMcpStatus('main', [
      { name: 'gmail', status: 'connected' },
      { name: 'slow', status: 'pending' },
    ]);

    expect(notify).not.toHaveBeenCalled();
  });

  it('survives a notify that throws or rejects', () => {
    setMcpHealthNotify(() => {
      throw new Error('boom');
    });
    expect(() =>
      recordMcpStatus('main', [{ name: 'a', status: 'failed' }]),
    ).not.toThrow();

    setMcpHealthNotify(() => Promise.reject(new Error('boom')));
    expect(() =>
      recordMcpStatus('main', [{ name: 'b', status: 'failed' }]),
    ).not.toThrow();
  });
});

describe('mcp-health: extractMcpStatusReports', () => {
  it('extracts a complete report and ignores surrounding output', () => {
    const servers = [{ name: 'joplin', status: 'failed' }];
    const { reports } = extractMcpStatusReports(
      `---NANOCLAW_OUTPUT_START---\n{}\n---NANOCLAW_OUTPUT_END---\n${wrap(servers)}`,
    );
    expect(reports).toEqual([servers]);
  });

  it('reassembles a report split across chunks', () => {
    const servers = [{ name: 'joplin', status: 'failed' }];
    const full = wrap(servers);
    const cut = 10; // inside the start marker itself

    const first = extractMcpStatusReports('noise ' + full.slice(0, cut));
    expect(first.reports).toEqual([]);

    const second = extractMcpStatusReports(first.rest + full.slice(cut));
    expect(second.reports).toEqual([servers]);
  });

  it('does not retain unbounded output when no marker is present', () => {
    const { rest } = extractMcpStatusReports('x'.repeat(100_000));
    expect(rest.length).toBeLessThan(MCP_STATUS_START_MARKER.length);
  });

  it('skips a malformed report without throwing', () => {
    const { reports } = extractMcpStatusReports(
      `${MCP_STATUS_START_MARKER}not json${MCP_STATUS_END_MARKER}${wrap([])}`,
    );
    expect(reports).toEqual([[]]);
  });
});
